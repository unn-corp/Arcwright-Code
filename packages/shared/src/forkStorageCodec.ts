// @effect-diagnostics nodeBuiltinImport:off
/** Private, lossless payload storage. References never cross the application wire. */
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import type * as NodeSqlite from "node:sqlite";

export const PAYLOAD_PREFIX = "arcwright:payload:v1:";
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const PAYLOAD_INLINE_BYTES = 4096;
export const HISTORY_BLOCK_TARGET_BYTES = 256 * 1024;
// Oversized records occupy their own block, retaining the existing per-record limit.
const MAX_HISTORY_BLOCK_BYTES = MAX_PAYLOAD_BYTES + 4;
const HISTORY_BLOCK_MAGIC = Buffer.from("AWB1");
export const HISTORY_BLOCK_REFERENCE_BYTES = 40;
// Ordinary rowid storage avoids WITHOUT ROWID's large-blob overflow-page waste.
export const historyBlockSchema = `CREATE TABLE arcwright_history_blocks (
  digest TEXT PRIMARY KEY, raw_bytes INTEGER NOT NULL, compressed BLOB NOT NULL
)`;
export interface StoredBlob {
  readonly digest: string;
  readonly rawBytes: number;
  readonly compressed: Uint8Array;
}
export const digestBytes = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export function compressText(text: string): StoredBlob {
  const bytes = Buffer.from(text);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error("Storage payload exceeds its size limit.");
  return {
    digest: digestBytes(bytes),
    rawBytes: bytes.length,
    compressed: NodeZlib.gzipSync(bytes, { level: 3 }),
  };
}

export function expandBlob(blob: StoredBlob): string {
  if (
    !Number.isSafeInteger(blob.rawBytes) ||
    blob.rawBytes < 0 ||
    blob.rawBytes > MAX_PAYLOAD_BYTES
  )
    throw new Error("Invalid storage payload size.");
  const bytes = NodeZlib.gunzipSync(blob.compressed, {
    maxOutputLength: Math.max(1, blob.rawBytes),
  });
  if (bytes.length !== blob.rawBytes || digestBytes(bytes) !== blob.digest)
    throw new Error("Storage payload integrity check failed.");
  return bytes.toString("utf8");
}

export function compressHistoryBlock(bytes: Uint8Array): StoredBlob {
  if (bytes.length > MAX_HISTORY_BLOCK_BYTES)
    throw new Error("Historical block exceeds its size limit.");
  return {
    digest: digestBytes(bytes),
    rawBytes: bytes.length,
    compressed: NodeZlib.brotliCompressSync(bytes, {
      params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 7 },
    }),
  };
}

export function historyBlockReference(digest: string, offset: number): Uint8Array {
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_PAYLOAD_BYTES
  )
    throw new Error("Invalid historical block reference.");
  const ref = Buffer.alloc(HISTORY_BLOCK_REFERENCE_BYTES);
  HISTORY_BLOCK_MAGIC.copy(ref);
  Buffer.from(digest, "hex").copy(ref, 4);
  ref.writeUInt32BE(offset, 36);
  return ref;
}

export function isHistoryBlockReference(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).equals(HISTORY_BLOCK_MAGIC);
}

/** One bounded cache per connection. Re-read stored bytes so corruption, rollback and other writers cannot hide behind it. */
export function createHistoryDecoder(db: NodeSqlite.DatabaseSync): (blob: StoredBlob) => string {
  let lookup: ReturnType<NodeSqlite.DatabaseSync["prepare"]> | undefined;
  let cached: { digest: string; compressed: Buffer; bytes: Buffer } | undefined;
  return (blob) => {
    if (!isHistoryBlockReference(blob.compressed)) return expandBlob(blob);
    if (
      blob.compressed.length !== HISTORY_BLOCK_REFERENCE_BYTES ||
      !Number.isSafeInteger(blob.rawBytes) ||
      blob.rawBytes < 0 ||
      blob.rawBytes > MAX_PAYLOAD_BYTES
    )
      throw new Error("Invalid historical block reference.");
    const ref = Buffer.from(blob.compressed);
    const digest = ref.subarray(4, 36).toString("hex");
    const offset = ref.readUInt32BE(36);
    lookup ??= db.prepare(
      "SELECT raw_bytes,compressed FROM arcwright_history_blocks WHERE digest=?",
    );
    const row = lookup.get(digest) as { raw_bytes: number; compressed: Uint8Array } | undefined;
    if (row === undefined) throw new Error("Referenced historical block is missing.");
    if (
      !Number.isSafeInteger(row.raw_bytes) ||
      row.raw_bytes < 4 ||
      row.raw_bytes > MAX_HISTORY_BLOCK_BYTES
    )
      throw new Error("Invalid historical block size.");
    const compressed = Buffer.from(row.compressed);
    let bytes: Buffer;
    if (
      cached?.digest === digest &&
      cached.bytes.length === row.raw_bytes &&
      cached.compressed.equals(compressed)
    ) {
      bytes = cached.bytes;
    } else {
      bytes = NodeZlib.brotliDecompressSync(compressed, { maxOutputLength: row.raw_bytes });
      if (bytes.length !== row.raw_bytes || digestBytes(bytes) !== digest)
        throw new Error("Historical block integrity check failed.");
      cached =
        bytes.length <= HISTORY_BLOCK_TARGET_BYTES ? { digest, compressed, bytes } : undefined;
    }
    if (offset + 4 + blob.rawBytes > bytes.length || bytes.readUInt32BE(offset) !== blob.rawBytes)
      throw new Error("Invalid historical record boundary.");
    const record = bytes.subarray(offset + 4, offset + 4 + blob.rawBytes);
    if (digestBytes(record) !== blob.digest)
      throw new Error("Historical record integrity check failed.");
    return record.toString("utf8");
  };
}

export function payloadReference(blob: Pick<StoredBlob, "digest" | "rawBytes">): string {
  return `${PAYLOAD_PREFIX}${blob.digest}:${blob.rawBytes}`;
}

export function parsePayloadReference(
  value: string,
): Pick<StoredBlob, "digest" | "rawBytes"> | null {
  if (!value.startsWith(PAYLOAD_PREFIX)) return null;
  const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value.slice(PAYLOAD_PREFIX.length));
  const rawBytes = Number(match?.[2]);
  if (match === null || !Number.isSafeInteger(rawBytes) || rawBytes > MAX_PAYLOAD_BYTES)
    throw new Error("Invalid storage payload reference.");
  return { digest: match[1]!, rawBytes };
}

export const storageSchema = [
  `CREATE TABLE IF NOT EXISTS arcwright_payload_blobs (
    digest TEXT PRIMARY KEY, raw_bytes INTEGER NOT NULL, compressed BLOB NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS arcwright_history_rows (
    source TEXT NOT NULL, row_key TEXT NOT NULL, thread_id TEXT NOT NULL,
    sequence INTEGER, digest TEXT NOT NULL, raw_bytes INTEGER NOT NULL, compressed BLOB NOT NULL,
    PRIMARY KEY (source, row_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS arcwright_history_thread_idx
    ON arcwright_history_rows(source, thread_id, row_key)`,
  `CREATE TABLE IF NOT EXISTS arcwright_legacy_baselines (
    thread_id TEXT PRIMARY KEY, stream_version INTEGER NOT NULL, through_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL, message_count INTEGER NOT NULL, archived_at TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS arcwright_storage_runs (
    transaction_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
    report_json TEXT
  ) WITHOUT ROWID`,
] as const;

/** Register on every application connection, including command-line and recovery fixture readers. */
export function registerStorageFunctions(db: NodeSqlite.DatabaseSync): void {
  registerPortableStorageFunctions(db, NodeCrypto, NodeZlib);
}

/** No module paths or imported bindings are needed by the reader worker. */
export const portableStorageFunctionsSource = (): string =>
  registerPortableStorageFunctions.toString();

/** Self-contained so eval workers can register the identical checksummed codecs in bundled builds. */
function registerPortableStorageFunctions(
  db: NodeSqlite.DatabaseSync,
  NodeCrypto: typeof import("node:crypto"),
  NodeZlib: typeof import("node:zlib"),
): void {
  const PAYLOAD_PREFIX = "arcwright:payload:v1:";
  const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
  const HISTORY_BLOCK_TARGET_BYTES = 256 * 1024;
  const MAX_HISTORY_BLOCK_BYTES = MAX_PAYLOAD_BYTES + 4;
  const HISTORY_BLOCK_MAGIC = Buffer.from("AWB1");
  const HISTORY_BLOCK_REFERENCE_BYTES = 40;
  const digestBytes = (bytes: Uint8Array) =>
    NodeCrypto.createHash("sha256").update(bytes).digest("hex");

  function expandBlob(blob: StoredBlob): string {
    if (
      !Number.isSafeInteger(blob.rawBytes) ||
      blob.rawBytes < 0 ||
      blob.rawBytes > MAX_PAYLOAD_BYTES
    )
      throw new Error("Invalid storage payload size.");
    const bytes = NodeZlib.gunzipSync(blob.compressed, {
      maxOutputLength: Math.max(1, blob.rawBytes),
    });
    if (bytes.length !== blob.rawBytes || digestBytes(bytes) !== blob.digest)
      throw new Error("Storage payload integrity check failed.");
    return bytes.toString("utf8");
  }

  function isHistoryBlockReference(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).equals(HISTORY_BLOCK_MAGIC);
  }

  /** One bounded cache per connection. Re-read stored bytes so corruption, rollback and other writers cannot hide behind it. */
  function createHistoryDecoder(db: NodeSqlite.DatabaseSync): (blob: StoredBlob) => string {
    let lookup: ReturnType<NodeSqlite.DatabaseSync["prepare"]> | undefined;
    let cached: { digest: string; compressed: Buffer; bytes: Buffer } | undefined;
    return (blob) => {
      if (!isHistoryBlockReference(blob.compressed)) return expandBlob(blob);
      if (
        blob.compressed.length !== HISTORY_BLOCK_REFERENCE_BYTES ||
        !Number.isSafeInteger(blob.rawBytes) ||
        blob.rawBytes < 0 ||
        blob.rawBytes > MAX_PAYLOAD_BYTES
      )
        throw new Error("Invalid historical block reference.");
      const ref = Buffer.from(blob.compressed);
      const digest = ref.subarray(4, 36).toString("hex");
      const offset = ref.readUInt32BE(36);
      lookup ??= db.prepare(
        "SELECT raw_bytes,compressed FROM arcwright_history_blocks WHERE digest=?",
      );
      const row = lookup.get(digest) as { raw_bytes: number; compressed: Uint8Array } | undefined;
      if (row === undefined) throw new Error("Referenced historical block is missing.");
      if (
        !Number.isSafeInteger(row.raw_bytes) ||
        row.raw_bytes < 4 ||
        row.raw_bytes > MAX_HISTORY_BLOCK_BYTES
      )
        throw new Error("Invalid historical block size.");
      const compressed = Buffer.from(row.compressed);
      let bytes: Buffer;
      if (
        cached?.digest === digest &&
        cached.bytes.length === row.raw_bytes &&
        cached.compressed.equals(compressed)
      ) {
        bytes = cached.bytes;
      } else {
        bytes = NodeZlib.brotliDecompressSync(compressed, { maxOutputLength: row.raw_bytes });
        if (bytes.length !== row.raw_bytes || digestBytes(bytes) !== digest)
          throw new Error("Historical block integrity check failed.");
        cached =
          bytes.length <= HISTORY_BLOCK_TARGET_BYTES ? { digest, compressed, bytes } : undefined;
      }
      if (offset + 4 + blob.rawBytes > bytes.length || bytes.readUInt32BE(offset) !== blob.rawBytes)
        throw new Error("Invalid historical record boundary.");
      const record = bytes.subarray(offset + 4, offset + 4 + blob.rawBytes);
      if (digestBytes(record) !== blob.digest)
        throw new Error("Historical record integrity check failed.");
      return record.toString("utf8");
    };
  }

  function parsePayloadReference(value: string): Pick<StoredBlob, "digest" | "rawBytes"> | null {
    if (!value.startsWith(PAYLOAD_PREFIX)) return null;
    const match = /^([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(value.slice(PAYLOAD_PREFIX.length));
    const rawBytes = Number(match?.[2]);
    if (match === null || !Number.isSafeInteger(rawBytes) || rawBytes > MAX_PAYLOAD_BYTES)
      throw new Error("Invalid storage payload reference.");
    return { digest: match[1]!, rawBytes };
  }

  let lookup: ReturnType<NodeSqlite.DatabaseSync["prepare"]> | undefined;
  const decodeHistory = createHistoryDecoder(db);
  db.function("arcwright_payload_json", (input) => {
    if (typeof input !== "string") return input;
    const ref = parsePayloadReference(input);
    if (ref === null) return input;
    lookup ??= db.prepare(
      "SELECT raw_bytes, compressed FROM arcwright_payload_blobs WHERE digest = ?",
    );
    const row = lookup.get(ref.digest) as { raw_bytes: number; compressed: Uint8Array } | undefined;
    if (row === undefined || row.raw_bytes !== ref.rawBytes)
      throw new Error("Referenced storage payload is missing.");
    return expandBlob({ ...ref, compressed: row.compressed });
  });
  db.function("arcwright_history_json", (digest, rawBytes, compressed) => {
    if (
      typeof digest !== "string" ||
      typeof rawBytes !== "number" ||
      !(compressed instanceof Uint8Array)
    )
      throw new Error("Invalid historical archive row.");
    return decodeHistory({ digest, rawBytes, compressed });
  });
  // Replay limits must count original UTF-8 bytes without inflating archived bodies.
  db.function("arcwright_payload_bytes", { deterministic: true }, (input) => {
    if (typeof input !== "string") return 0;
    return parsePayloadReference(input)?.rawBytes ?? Buffer.byteLength(input);
  });
}
