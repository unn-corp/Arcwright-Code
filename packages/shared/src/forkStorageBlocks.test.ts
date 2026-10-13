// @effect-diagnostics nodeBuiltinImport:off -- isolated native SQLite fixtures
import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import { archiveRow, readArchivedRow } from "./forkStorageArchive.ts";
import { compactHistoryBlocks } from "./forkStorageBlocks.ts";
import {
  historyBlockSchema,
  storageSchema,
  registerStorageFunctions,
  HISTORY_BLOCK_TARGET_BYTES,
} from "./forkStorageCodec.ts";

function fixture() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  for (const sql of storageSchema) db.exec(sql);
  db.exec(historyBlockSchema);
  registerStorageFunctions(db);
  return db;
}
const source = "projection_thread_activities";
const history = (n: number) => ({ id: n, text: `${n}: original 🧰 output\n`.repeat(40) });
function seed(db: NodeSqlite.DatabaseSync, count: number) {
  for (let n = 0; n < count; n++)
    archiveRow(db, source, String(n).padStart(5, "0"), "thread", history(n));
}

it("shrinks blocks across batches, preserves indexed reads, and resumes without repacking completed records", async () => {
  const db = fixture();
  try {
    seed(db, 1300);
    const before = db
      .prepare("SELECT SUM(length(compressed)) AS bytes FROM arcwright_history_rows")
      .get()!.bytes as number;
    await expect(
      compactHistoryBlocks(db, async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    const packed = db.prepare("SELECT COUNT(*) AS n FROM arcwright_history_blocks").get()!
      .n as number;
    expect(packed).toBeGreaterThan(0);
    expect((await compactHistoryBlocks(db, async () => {})).packedRows).toBe(276);
    for (let n = 0; n < 1300; n++)
      expect(readArchivedRow(db, source, String(n).padStart(5, "0"))).toEqual(history(n));
    const after = db
      .prepare(
        "SELECT (SELECT SUM(length(compressed)) FROM arcwright_history_rows) + (SELECT SUM(length(compressed)) FROM arcwright_history_blocks) AS bytes",
      )
      .get()!.bytes as number;
    expect(after).toBeLessThan(before);
    const blocks = db.prepare("SELECT * FROM arcwright_history_blocks ORDER BY digest").all();
    expect((await compactHistoryBlocks(db, async () => {})).packedRows).toBe(0);
    expect(db.prepare("SELECT * FROM arcwright_history_blocks ORDER BY digest").all()).toEqual(
      blocks,
    );
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT source,thread_id,row_key FROM arcwright_history_rows INDEXED BY arcwright_history_thread_idx WHERE (source,thread_id,row_key) > (?,?,?) ORDER BY source,thread_id,row_key LIMIT 1024",
      )
      .all("", "", "") as { detail: string }[];
    expect(plan.some((r) => r.detail.includes("TEMP B-TREE"))).toBe(false);
    expect(
      plan.some(
        (r) => r.detail.includes("SEARCH") && r.detail.includes("arcwright_history_thread_idx"),
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

it("rolls back block and reference writes together if even one record cannot be updated", async () => {
  const db = fixture();
  try {
    seed(db, 20);
    const before = db.prepare("SELECT * FROM arcwright_history_rows ORDER BY row_key").all();
    db.exec(
      "CREATE TRIGGER fail_reference BEFORE UPDATE ON arcwright_history_rows WHEN NEW.row_key='00010' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END",
    );
    await expect(compactHistoryBlocks(db, async () => {})).rejects.toThrow("fixture write failure");
    expect(db.prepare("SELECT COUNT(*) AS n FROM arcwright_history_blocks").get()!.n).toBe(0);
    expect(db.prepare("SELECT * FROM arcwright_history_rows ORDER BY row_key").all()).toEqual(
      before,
    );
    db.exec("DROP TRIGGER fail_reference");
    expect((await compactHistoryBlocks(db, async () => {})).packedRows).toBe(20);
  } finally {
    db.close();
  }
});

it("keeps tiny gzip records, packs oversized outputs alone, and preserves all source and thread boundaries", async () => {
  const db = fixture();
  try {
    const large = { text: "very large preserved 🧰 output".repeat(30_000) };
    archiveRow(db, source, "large", "thread", large);
    archiveRow(db, source, "tiny", "thread", { text: "small" });
    archiveRow(db, "orchestration_events", "large", "other-thread", large);
    expect(await compactHistoryBlocks(db, async () => {})).toMatchObject({
      packedRows: 2,
      blocks: 1,
    });
    expect(readArchivedRow(db, source, "large")).toEqual(large);
    expect(readArchivedRow(db, "orchestration_events", "large")).toEqual(large);
    expect(readArchivedRow(db, source, "tiny")).toEqual({ text: "small" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM arcwright_history_blocks").get()!.n).toBe(1);
    expect(
      db.prepare("SELECT raw_bytes FROM arcwright_history_blocks").get()!.raw_bytes,
    ).toBeGreaterThan(HISTORY_BLOCK_TARGET_BYTES);
  } finally {
    db.close();
  }
});

it("detects corrupt or missing blocks even after a cached read, and rejects altered record lengths and digests", async () => {
  const db = fixture();
  try {
    seed(db, 20);
    await compactHistoryBlocks(db, async () => {});
    const read = db.prepare(
      "SELECT arcwright_history_json(digest,raw_bytes,compressed) AS json FROM arcwright_history_rows WHERE row_key='00000'",
    );
    expect(JSON.parse(read.get()!.json as string)).toEqual(history(0));
    const block = db.prepare("SELECT * FROM arcwright_history_blocks").get()!;
    const row = db.prepare("SELECT * FROM arcwright_history_rows WHERE row_key='00000'").get()!;
    db.prepare("UPDATE arcwright_history_rows SET compressed=? WHERE row_key='00000'").run(
      (row.compressed as Uint8Array).subarray(0, 39),
    );
    expect(() => read.get()).toThrow();
    const invalidOffset = Buffer.from(row.compressed as Uint8Array);
    invalidOffset.writeUInt32BE(0xffffffff, 36);
    db.prepare("UPDATE arcwright_history_rows SET compressed=? WHERE row_key='00000'").run(
      invalidOffset,
    );
    expect(() => read.get()).toThrow();
    db.prepare("UPDATE arcwright_history_rows SET compressed=? WHERE row_key='00000'").run(
      row.compressed!,
    );
    db.exec("UPDATE arcwright_history_blocks SET raw_bytes=4");
    expect(() => read.get()).toThrow();
    db.prepare("UPDATE arcwright_history_blocks SET raw_bytes=?").run(block.raw_bytes!);
    db.exec("UPDATE arcwright_history_blocks SET compressed=x'00'");
    expect(() => read.get()).toThrow();
    db.prepare("UPDATE arcwright_history_blocks SET compressed=?").run(block.compressed!);
    db.exec("UPDATE arcwright_history_rows SET raw_bytes=raw_bytes+1 WHERE row_key='00000'");
    expect(() => read.get()).toThrow();
    db.exec(
      "UPDATE arcwright_history_rows SET raw_bytes=raw_bytes-1,digest='bad' WHERE row_key='00000'",
    );
    expect(() => read.get()).toThrow();
    db.exec("DELETE FROM arcwright_history_blocks");
    expect(() => readArchivedRow(db, source, "00001")).toThrow("missing");
  } finally {
    db.close();
  }
});
