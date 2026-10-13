// @effect-diagnostics nodeBuiltinImport:off
/** Cold history only: the admitted maintenance worker owns every rewrite. */
import type * as NodeSqlite from "node:sqlite";
import {
  compressHistoryBlock,
  createHistoryDecoder,
  historyBlockReference,
  isHistoryBlockReference,
  HISTORY_BLOCK_REFERENCE_BYTES,
  HISTORY_BLOCK_TARGET_BYTES,
} from "./forkStorageCodec.ts";
import type { ArchiveProgress } from "./forkStorageArchive.ts";

interface Key {
  source: string;
  thread_id: string;
  row_key: string;
}
interface Pending extends Key {
  digest: string;
  rawBytes: number;
  bytes: Buffer;
  storedBytes: number;
}

/** Indexed keyset scan, bounded blocks, atomic references. An interrupted batch leaves its original records intact. */
export async function compactHistoryBlocks(
  db: NodeSqlite.DatabaseSync,
  yieldWork: (progress: ArchiveProgress) => Promise<void>,
) {
  const keys =
    db.prepare(`SELECT source,thread_id,row_key FROM arcwright_history_rows INDEXED BY arcwright_history_thread_idx
    WHERE (source,thread_id,row_key) > (?,?,?) ORDER BY source,thread_id,row_key LIMIT 1024`);
  const read = db.prepare(
    "SELECT digest,raw_bytes,compressed FROM arcwright_history_rows WHERE source=? AND row_key=?",
  );
  const insert = db.prepare(
    "INSERT INTO arcwright_history_blocks(digest,raw_bytes,compressed) VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING",
  );
  const update = db.prepare(
    "UPDATE arcwright_history_rows SET compressed=? WHERE source=? AND row_key=?",
  );
  const decode = createHistoryDecoder(db);
  const report = {
    scannedRows: 0,
    packedRows: 0,
    blocks: 0,
    originalCompressedBytes: 0,
    packedBytes: 0,
  };
  let cursor = ["", "", ""];
  let pending: Pending[] = [];
  let size = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    for (const row of pending) {
      bytes.writeUInt32BE(row.rawBytes, offset);
      row.bytes.copy(bytes, offset + 4);
      offset += row.rawBytes + 4;
    }
    const blob = compressHistoryBlock(bytes);
    const before = pending.reduce((sum, row) => sum + row.storedBytes, 0);
    const after = blob.compressed.length + pending.length * HISTORY_BLOCK_REFERENCE_BYTES;
    // Include block metadata/index overhead; incompressible or tiny groups keep their original encoding.
    if (after + 256 < before) {
      const inserted = insert.run(blob.digest, blob.rawBytes, blob.compressed).changes !== 0;
      offset = 0;
      for (const row of pending) {
        const reference = historyBlockReference(blob.digest, offset);
        if (
          decode({ digest: row.digest, rawBytes: row.rawBytes, compressed: reference }) !==
          row.bytes.toString("utf8")
        )
          throw new Error("Historical block verification failed; original records retained.");
        update.run(reference, row.source, row.row_key);
        offset += row.rawBytes + 4;
      }
      report.packedRows += pending.length;
      if (inserted) report.blocks += 1;
      report.originalCompressedBytes += before;
      report.packedBytes +=
        pending.length * HISTORY_BLOCK_REFERENCE_BYTES + (inserted ? blob.compressed.length : 0);
    }
    pending = [];
    size = 0;
  };
  for (;;) {
    const batch = keys.all(...cursor) as unknown as Key[];
    if (batch.length === 0) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of batch) {
        const stored = read.get(key.source, key.row_key) as {
          digest: string;
          raw_bytes: number;
          compressed: Uint8Array;
        };
        const blob = {
          digest: stored.digest,
          rawBytes: stored.raw_bytes,
          compressed: stored.compressed,
        };
        const json = decode(blob);
        report.scannedRows += 1;
        if (isHistoryBlockReference(stored.compressed)) {
          flush();
          continue;
        }
        const first = pending[0];
        if (
          first !== undefined &&
          (first.source !== key.source ||
            first.thread_id !== key.thread_id ||
            size + stored.raw_bytes + 4 > HISTORY_BLOCK_TARGET_BYTES)
        )
          flush();
        pending.push({
          ...key,
          digest: stored.digest,
          rawBytes: stored.raw_bytes,
          bytes: Buffer.from(json),
          storedBytes: stored.compressed.length,
        });
        size += stored.raw_bytes + 4;
        if (size >= HISTORY_BLOCK_TARGET_BYTES) flush();
      }
      flush();
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    const last = batch.at(-1)!;
    cursor = [last.source, last.thread_id, last.row_key];
    await yieldWork({ stage: "history-blocks", rows: report.scannedRows });
  }
  return report;
}
