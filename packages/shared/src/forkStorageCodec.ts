// @effect-diagnostics nodeBuiltinImport:off
/** Private, lossless payload storage. References never cross the application wire. */
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import type * as NodeSqlite from "node:sqlite";

export const PAYLOAD_PREFIX = "arcwright:payload:v1:";
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const PAYLOAD_INLINE_BYTES = 4096;
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
  let lookup: ReturnType<NodeSqlite.DatabaseSync["prepare"]> | undefined;
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
    return expandBlob({ digest, rawBytes, compressed });
  });
  // Replay limits must count original UTF-8 bytes without inflating archived bodies.
  db.function("arcwright_payload_bytes", { deterministic: true }, (input) => {
    if (typeof input !== "string") return 0;
    return parsePayloadReference(input)?.rawBytes ?? Buffer.byteLength(input);
  });
}
