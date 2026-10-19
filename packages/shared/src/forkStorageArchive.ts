// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
/** Lossless offline rewrites. The maintenance adapter owns admission and recovery. */
import type * as NodeSqlite from "node:sqlite";
import {
  compressText,
  createHistoryDecoder,
  parsePayloadReference,
  payloadReference,
  PAYLOAD_INLINE_BYTES,
  MAX_PAYLOAD_BYTES,
} from "./forkStorageCodec.ts";

export const HISTORY_SOURCES = [
  "projection_thread_activities",
  "orchestration_events",
  "orchestration_command_receipts",
  "projection_thread_messages",
] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];
type Row = Record<string, string | number | null>;
const historyDecoders = new WeakMap<
  NodeSqlite.DatabaseSync,
  ReturnType<typeof createHistoryDecoder>
>();

export function archiveRow(
  db: NodeSqlite.DatabaseSync,
  source: HistorySource,
  key: string,
  threadId: string,
  row: Row,
): void {
  const json = JSON.stringify(row);
  const blob = compressText(json);
  db.prepare(`INSERT INTO arcwright_history_rows(source,row_key,thread_id,sequence,digest,raw_bytes,compressed)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,row_key) DO NOTHING`).run(
    source,
    key,
    threadId,
    typeof row.sequence === "number" ? row.sequence : null,
    blob.digest,
    blob.rawBytes,
    blob.compressed,
  );
  const restored = readArchivedRow(db, source, key);
  if (JSON.stringify(restored) !== json)
    throw new Error("Historical archive verification failed; original row retained.");
}

export function readArchivedRow(
  db: NodeSqlite.DatabaseSync,
  source: HistorySource,
  key: string,
): Row | null {
  const row = db
    .prepare(
      "SELECT digest,raw_bytes,compressed FROM arcwright_history_rows WHERE source=? AND row_key=?",
    )
    .get(source, key) as { digest: string; raw_bytes: number; compressed: Uint8Array } | undefined;
  if (row === undefined) return null;
  let decode = historyDecoders.get(db);
  if (decode === undefined) {
    decode = createHistoryDecoder(db);
    historyDecoders.set(db, decode);
  }
  return JSON.parse(
    decode({ digest: row.digest, rawBytes: row.raw_bytes, compressed: row.compressed }),
  ) as Row;
}

function storePayloadSync(db: NodeSqlite.DatabaseSync, json: string): string {
  const bytes = Buffer.byteLength(json);
  if (parsePayloadReference(json) !== null) {
    // An existing reference must remain readable before a maintenance run can complete.
    db.prepare("SELECT arcwright_payload_json(?)").get(json);
    return json;
  }
  if (bytes < PAYLOAD_INLINE_BYTES || bytes > MAX_PAYLOAD_BYTES) return json;
  const blob = compressText(json);
  if (blob.compressed.length + 160 >= blob.rawBytes) return json;
  db.prepare(
    "INSERT INTO arcwright_payload_blobs(digest,raw_bytes,compressed) VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING",
  ).run(blob.digest, blob.rawBytes, blob.compressed);
  const verified = db
    .prepare("SELECT arcwright_payload_json(?) AS json")
    .get(payloadReference(blob)) as { json: string };
  if (verified.json !== json) throw new Error("Compressed payload verification failed.");
  return payloadReference(blob);
}

/** Only completed imports with transcript parity acquire a durable legacy replay/clock boundary. */
export function recordLegacyBaselines(db: NodeSqlite.DatabaseSync, now: string): void {
  // The version-only index can rescan every legacy event for each imported thread. Bound this join to each stream.
  db.prepare(`INSERT INTO arcwright_legacy_baselines(thread_id,stream_version,through_sequence,event_count,message_count,archived_at)
    SELECT imported.thread_id,COALESCE(MAX(event.stream_version),-1),COALESCE(MAX(event.sequence),0),
      COUNT(event.sequence),imported.imported_message_count,?
    FROM orchestration_v2_legacy_imports imported
    LEFT JOIN orchestration_events event INDEXED BY idx_orch_events_stream_sequence
      ON event.aggregate_kind='thread' AND event.stream_id=imported.thread_id
      AND event.application_event_version=1
    WHERE imported.transcript_imported_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads thread WHERE thread.thread_id=imported.thread_id)
      AND imported.imported_message_count=(SELECT COUNT(*) FROM projection_thread_messages message
        WHERE message.thread_id=imported.thread_id AND message.role IN ('user','assistant'))
      AND NOT EXISTS (SELECT 1 FROM projection_thread_messages message
        WHERE message.thread_id=imported.thread_id AND message.role IN ('user','assistant')
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages current WHERE current.message_id=message.message_id AND current.thread_id=imported.thread_id))
    GROUP BY imported.thread_id ON CONFLICT(thread_id) DO NOTHING`).run(now);
}

const specs = {
  projection_thread_activities: {
    key: "activity_id",
    thread: "thread_id",
    where: "thread_id IN (SELECT thread_id FROM arcwright_legacy_baselines)",
  },
  orchestration_events: {
    key: "sequence",
    thread: "stream_id",
    where:
      "aggregate_kind='thread' AND application_event_version=1 AND stream_id IN (SELECT thread_id FROM arcwright_legacy_baselines)",
  },
  projection_thread_messages: {
    key: "message_id",
    thread: "thread_id",
    where: "role='reasoning' AND thread_id IN (SELECT thread_id FROM arcwright_legacy_baselines)",
  },
  orchestration_command_receipts: {
    key: "command_id",
    thread: "aggregate_id",
    where: `aggregate_kind='thread' AND command_type='legacy'
    AND aggregate_id IN (SELECT thread_id FROM arcwright_legacy_baselines)
    AND accepted_at < ? AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox effect
      WHERE effect.command_id=orchestration_command_receipts.command_id AND effect.status NOT IN ('succeeded','failed','cancelled'))`,
  },
} as const;

export interface ArchiveProgress {
  readonly stage: string;
  readonly rows: number;
}

/** Batches commit independently. Repeating after interruption verifies existing archives before deleting originals. */
export async function archiveLegacyHistory(
  db: NodeSqlite.DatabaseSync,
  cutoff: string,
  yieldWork: (progress: ArchiveProgress) => Promise<void>,
): Promise<Record<HistorySource, number>> {
  const counts = Object.fromEntries(HISTORY_SOURCES.map((source) => [source, 0])) as Record<
    HistorySource,
    number
  >;
  for (const source of HISTORY_SOURCES) {
    const spec = specs[source];
    let cursor = 0;
    for (;;) {
      const keys = db
        // Resume on the rowid tree. Legacy thread indexes otherwise re-sort millions of candidates for every 128-row batch.
        .prepare(`SELECT rowid AS position, ${spec.key} AS key FROM ${source} NOT INDEXED
        WHERE rowid > ? AND ${spec.where} ORDER BY rowid LIMIT 128`)
        .all(...(source === "orchestration_command_receipts" ? [cursor, cutoff] : [cursor])) as {
        position: number;
        key: string | number;
      }[];
      if (keys.length === 0) break;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const key of keys) {
          // Read one body at a time, so a page of large tool outputs cannot exhaust RAM.
          const row = db.prepare(`SELECT * FROM ${source} WHERE ${spec.key}=?`).get(key.key) as Row;
          if (Buffer.byteLength(JSON.stringify(row)) > MAX_PAYLOAD_BYTES) continue;
          if (source === "orchestration_command_receipts") {
            // Small receipts already are cheap durable tombstones. Never expand them with archive metadata.
            const rawBytes = Object.values(row).reduce<number>(
              (sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 8),
              0,
            );
            const compressed = compressText(JSON.stringify(row)).compressed.length;
            if (
              compressed + 512 + 2 * (String(key.key).length + String(row[spec.thread]).length) >=
              rawBytes
            )
              continue;
          }
          archiveRow(db, source, String(key.key), String(row[spec.thread]), row);
          db.prepare(`DELETE FROM ${source} WHERE ${spec.key}=?`).run(key.key);
          counts[source] += 1;
        }
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      cursor = keys.at(-1)!.position;
      await yieldWork({ stage: source, rows: counts[source] });
    }
  }
  return counts;
}

/** Preserve every V2 sequence and event boundary, including intermediate progress, approvals and finals. */
export async function compressEventHistory(
  db: NodeSqlite.DatabaseSync,
  yieldWork: (progress: ArchiveProgress) => Promise<void>,
): Promise<number> {
  let cursor = 0;
  let compressed = 0;
  for (;;) {
    const keys = db
      .prepare(
        "SELECT sequence FROM orchestration_events WHERE sequence>? ORDER BY sequence LIMIT 128",
      )
      .all(cursor) as { sequence: number }[];
    if (keys.length === 0) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { sequence } of keys) {
        const row = db
          .prepare("SELECT payload_json FROM orchestration_events WHERE sequence=?")
          .get(sequence) as { payload_json: string };
        const stored = storePayloadSync(db, row.payload_json);
        if (stored !== row.payload_json) {
          db.prepare(
            "UPDATE orchestration_events SET payload_json=?,payload_bytes=? WHERE sequence=?",
          ).run(stored, Buffer.byteLength(row.payload_json), sequence);
          compressed += 1;
        }
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    cursor = keys.at(-1)!.sequence;
    await yieldWork({ stage: "event-payloads", rows: compressed });
  }
  return compressed;
}

/** Tool projections and the event that produced them share the same content-addressed body. */
export async function compressTurnItemHistory(
  db: NodeSqlite.DatabaseSync,
  yieldWork: (progress: ArchiveProgress) => Promise<void>,
): Promise<number> {
  let cursor = 0,
    compressed = 0;
  for (;;) {
    const keys = db
      .prepare(
        "SELECT rowid AS position,turn_item_id FROM orchestration_v2_projection_turn_items WHERE rowid>? ORDER BY rowid LIMIT 128",
      )
      .all(cursor) as { position: number; turn_item_id: string }[];
    if (keys.length === 0) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of keys) {
        const row = db
          .prepare(
            "SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id=?",
          )
          .get(key.turn_item_id) as { payload_json: string };
        const stored = storePayloadSync(db, row.payload_json);
        if (stored !== row.payload_json) {
          db.prepare(
            "UPDATE orchestration_v2_projection_turn_items SET payload_json=? WHERE turn_item_id=?",
          ).run(stored, key.turn_item_id);
          compressed += 1;
        }
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    cursor = keys.at(-1)!.position;
    await yieldWork({ stage: "tool-projections", rows: compressed });
  }
  return compressed;
}
