// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/** Offline copy conversion. This module never opens its source for writing. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import {
  createHistoryDecoder,
  PAYLOAD_PREFIX,
  registerStorageFunctions,
} from "./forkStorageCodec.ts";
import { HISTORY_SOURCES } from "./forkStorageArchive.ts";

type Row = Record<string, string | number | null>;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function assertHeadroom(directory: string, additionalBytes = 0) {
  const space = await NodeFSP.statfs(directory);
  if (Number(space.bavail) * Number(space.bsize) < additionalBytes + 8 * 1024 ** 3)
    throw new Error("Insufficient free space for a safe copy and expansion headroom.");
}
const keys = {
  orchestration_events: "sequence",
  projection_thread_activities: "activity_id",
  projection_thread_messages: "message_id",
  orchestration_command_receipts: "command_id",
} as const;

export interface UpstreamStorageCopyOptions {
  readonly source: string;
  /** Must not exist. All writes, including the verification receipt, stay here. */
  readonly destinationDirectory: string;
  /** An already frozen, read-only rollback-journal snapshot can use a CoW copy. */
  readonly immutableSnapshot?: boolean;
  readonly progress?: (stage: string, rows: number) => Promise<void>;
}

function readRows(db: NodeSqlite.DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number })
    .count;
}

function schema(db: NodeSqlite.DatabaseSync) {
  return db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
    )
    .all();
}

function ledger(db: NodeSqlite.DatabaseSync) {
  return db.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all();
}

function archivedRow(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Historical row is not an object.");
  const row: Row = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string" && typeof item !== "number")
      throw new Error("Historical row contains an unsupported field value.");
    row[key] = item;
  }
  return row;
}

function restorePrompt(db: NodeSqlite.DatabaseSync, json: string, streamId: string) {
  const value = JSON.parse(json) as { promptSequence?: unknown };
  if (!Number.isInteger(value.promptSequence)) return json;
  const anchor = db
    .prepare(
      "SELECT arcwright_payload_json(payload_json) AS payload_json,stream_id FROM orchestration_events WHERE sequence=?",
    )
    .get(value.promptSequence as number) as { payload_json: string; stream_id: string } | undefined;
  const prompt =
    anchor === undefined
      ? undefined
      : (JSON.parse(anchor.payload_json) as { prompt?: unknown; promptSequence?: unknown });
  if (
    anchor === undefined ||
    anchor.stream_id !== streamId ||
    typeof prompt?.prompt !== "string" ||
    prompt.promptSequence !== undefined
  )
    throw new Error("Prompt anchor is missing, cross-thread, or recursive; conversion blocked.");
  return (
    db
      .prepare("SELECT json_set(json_remove(?,'$.promptSequence'),'$.prompt',?) AS json")
      .get(json, prompt.prompt) as { json: string }
  ).json;
}

function comparableField(db: NodeSqlite.DatabaseSync, source: string, row: Row, column: string) {
  const original = row[column];
  if (column !== "payload_json" || typeof original !== "string") return original;
  const decoded = (
    db.prepare("SELECT arcwright_payload_json(?) AS json").get(original) as { json: string }
  ).json;
  return source === "orchestration_events" &&
    (row.event_type === "subagent.updated" || row.event_type === "turn-item.updated") &&
    typeof row.stream_id === "string"
    ? restorePrompt(db, decoded, row.stream_id)
    : decoded;
}

async function restoreArchives(
  db: NodeSqlite.DatabaseSync,
  progress: UpstreamStorageCopyOptions["progress"],
  reserve: (bytes: number) => Promise<void>,
) {
  const decode = createHistoryDecoder(db);
  const restored: Record<string, number> = {};
  let sourceCursor = "",
    keyCursor = "",
    visited = 0;
  for (;;) {
    const rows = db
      .prepare(`SELECT source,row_key FROM arcwright_history_rows
      WHERE (source,row_key)>(?,?) ORDER BY source,row_key LIMIT 64`)
      .all(sourceCursor, keyCursor) as Array<{ source: string; row_key: string }>;
    if (rows.length === 0) break;
    for (const key of rows) {
      const entry = db
        .prepare(
          "SELECT source,row_key,digest,raw_bytes,compressed FROM arcwright_history_rows WHERE source=? AND row_key=?",
        )
        .get(key.source, key.row_key) as {
        source: string;
        row_key: string;
        digest: string;
        raw_bytes: number;
        compressed: Uint8Array;
      };
      if (!HISTORY_SOURCES.some((source) => source === entry.source))
        throw new Error("Unknown historical source; copy retained for inspection.");
      const source = entry.source as keyof typeof keys;
      const row = archivedRow(
        JSON.parse(
          decode({ digest: entry.digest, rawBytes: entry.raw_bytes, compressed: entry.compressed }),
        ),
      );
      const columns = Object.keys(row);
      const known = new Set(
        (db.prepare(`PRAGMA table_xinfo(${quote(source)})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
      if (
        columns.some((column) => !known.has(column)) ||
        String(row[keys[source]]) !== entry.row_key
      )
        throw new Error("Historical row schema or identity does not match its source.");
      const current = db
        .prepare(
          `SELECT ${columns.map(quote).join(",")} FROM ${quote(source)} WHERE ${quote(keys[source])}=?`,
        )
        .get(row[keys[source]]!) as Row | undefined;
      if (current !== undefined) {
        if (
          columns.some(
            (column) =>
              comparableField(db, source, current, column) !==
              comparableField(db, source, row, column),
          )
        )
          throw new Error(
            "Historical row conflicts with an existing row; neither was overwritten.",
          );
      } else {
        await reserve(entry.raw_bytes * 2);
        db.prepare(
          `INSERT INTO ${quote(source)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...columns.map((column) => row[column]!));
        const saved = db
          .prepare(
            `SELECT ${columns.map(quote).join(",")} FROM ${quote(source)} WHERE ${quote(keys[source])}=?`,
          )
          .get(row[keys[source]]!) as Row;
        if (columns.some((column) => saved[column] !== row[column]))
          throw new Error("Restored historical row failed verification.");
        restored[source] = (restored[source] ?? 0) + 1;
      }
      sourceCursor = entry.source;
      keyCursor = entry.row_key;
      visited++;
    }
    await progress?.("archives", visited);
  }
  return restored;
}

async function expandPayloads(
  db: NodeSqlite.DatabaseSync,
  table: string,
  progress: UpstreamStorageCopyOptions["progress"],
  reserve: (bytes: number) => Promise<void>,
) {
  let cursor = 0,
    expanded = 0;
  for (;;) {
    // octet_length can reject large inline values using the record header, without reading overflow pages.
    const rows = db
      .prepare(`SELECT rowid AS position,payload_json FROM ${quote(table)}
      WHERE rowid>? AND octet_length(payload_json)<=128 AND payload_json GLOB ? ORDER BY rowid LIMIT 64`)
      .all(cursor, PAYLOAD_PREFIX + "*") as Array<{ position: number; payload_json: string }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      const value = db
        .prepare("SELECT arcwright_payload_json(?) AS json")
        .get(row.payload_json) as { json: string };
      if (typeof value.json !== "string" || value.json.startsWith(PAYLOAD_PREFIX))
        throw new Error("Payload did not expand to ordinary JSON.");
      JSON.parse(value.json);
      await reserve(Buffer.byteLength(value.json) * 2);
      db.prepare(`UPDATE ${quote(table)} SET payload_json=? WHERE rowid=? AND payload_json=?`).run(
        value.json,
        row.position,
        row.payload_json,
      );
      const saved = db
        .prepare(`SELECT payload_json FROM ${quote(table)} WHERE rowid=?`)
        .get(row.position) as { payload_json: string };
      if (saved.payload_json !== value.json)
        throw new Error("Expanded payload did not preserve its exact decoded bytes.");
      expanded++;
      cursor = row.position;
    }
    await progress?.("payloads:" + table, expanded);
  }
  return expanded;
}

async function expandPrompts(
  db: NodeSqlite.DatabaseSync,
  progress: UpstreamStorageCopyOptions["progress"],
  reserve: (bytes: number) => Promise<void>,
) {
  // Validate the original graph before any expansion can turn an invalid chain into a valid anchor.
  if (
    db
      .prepare(`SELECT 1 FROM orchestration_events AS candidate
      LEFT JOIN orchestration_events AS anchor ON anchor.sequence=json_extract(candidate.payload_json,'$.promptSequence')
      WHERE candidate.event_type IN ('subagent.updated','turn-item.updated')
        AND json_type(candidate.payload_json,'$.promptSequence') IS NOT NULL
        AND (json_type(candidate.payload_json,'$.promptSequence') IS NOT 'integer'
          OR anchor.sequence IS NULL OR anchor.stream_id IS NOT candidate.stream_id
          OR json_type(anchor.payload_json,'$.prompt') IS NOT 'text'
          OR json_type(anchor.payload_json,'$.promptSequence') IS NOT NULL) LIMIT 1`)
      .get()
  )
    throw new Error(
      "Prompt anchor is missing, cross-thread, recursive, or malformed; conversion blocked.",
    );
  let cursor = 0,
    expanded = 0;
  for (;;) {
    const rows = db
      .prepare(`SELECT sequence FROM orchestration_events
      WHERE sequence>? AND event_type IN ('subagent.updated','turn-item.updated')
        AND json_type(payload_json,'$.promptSequence')='integer' ORDER BY sequence LIMIT 64`)
      .all(cursor) as Array<{ sequence: number }>;
    if (rows.length === 0) break;
    for (const key of rows) {
      const row = db
        .prepare(
          "SELECT sequence,payload_json,stream_id FROM orchestration_events WHERE sequence=?",
        )
        .get(key.sequence) as { sequence: number; payload_json: string; stream_id: string };
      const restored = { json: restorePrompt(db, row.payload_json, row.stream_id) };
      await reserve(Buffer.byteLength(restored.json) * 2);
      db.prepare("UPDATE orchestration_events SET payload_json=? WHERE sequence=?").run(
        restored.json,
        row.sequence,
      );
      const saved = db
        .prepare("SELECT payload_json FROM orchestration_events WHERE sequence=?")
        .get(row.sequence) as { payload_json: string };
      if (saved.payload_json !== restored.json)
        throw new Error("Restored prompt failed verification.");
      expanded++;
      cursor = row.sequence;
    }
    await progress?.("prompts", expanded);
  }
  return expanded;
}

/** Caller holds the write transaction, including its durable completion receipt. */
export async function normalizeStorageJson(
  db: NodeSqlite.DatabaseSync,
  progress: UpstreamStorageCopyOptions["progress"],
  reserve: (bytes: number) => Promise<void>,
) {
  if (!db.isTransaction)
    throw new Error("Storage normalization requires a caller-held write transaction.");
  registerStorageFunctions(db);
  const beforeSchema = hash(schema(db)),
    beforeLedger = hash(ledger(db));
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const before = Object.fromEntries(tables.map((table) => [table, readRows(db, table)]));
  const restored = tables.includes("arcwright_history_rows")
    ? await restoreArchives(db, progress, reserve)
    : {};
  const payloads: Record<string, number> = {};
  for (const table of tables) {
    const hasPayload = (
      db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all() as Array<{ name: string }>
    ).some((column) => column.name === "payload_json");
    if (hasPayload) {
      payloads[table] = await expandPayloads(db, table, progress, reserve);
      if (
        db
          .prepare(
            `SELECT 1 FROM ${quote(table)} WHERE payload_json GLOB ? OR (payload_json IS NOT NULL AND json_valid(payload_json)=0) LIMIT 1`,
          )
          .get(PAYLOAD_PREFIX + "*")
      )
        throw new Error("A payload still contains an unsupported reference or invalid JSON.");
    }
  }
  const prompts = await expandPrompts(db, progress, reserve);
  if (
    db
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE event_type IN ('subagent.updated','turn-item.updated') AND json_type(payload_json,'$.promptSequence') IS NOT NULL LIMIT 1",
      )
      .get()
  )
    throw new Error("A prompt still contains an unsupported anchor reference.");
  const after = Object.fromEntries(tables.map((table) => [table, readRows(db, table)]));
  if (tables.some((table) => after[table] !== before[table]! + (restored[table] ?? 0)))
    throw new Error("Table row counts changed outside verified archive restoration.");
  if (beforeSchema !== hash(schema(db)) || beforeLedger !== hash(ledger(db)))
    throw new Error("Schema or historical migration ledger changed.");
  await progress?.("integrity", 0);
  const integrity = db.prepare("PRAGMA quick_check").all();
  if (
    integrity.length !== 1 ||
    Object.values(integrity[0]!)[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length !== 0
  )
    throw new Error("Converted copy failed SQLite integrity or foreign-key verification.");
  return {
    schemaUnchanged: true as const,
    ledgerUnchanged: true as const,
    tableRowsBefore: before,
    tableRowsAfter: after,
    archiveRowsRestored: restored,
    payloadsExpanded: payloads,
    promptsExpanded: prompts,
    integrity: "ok" as const,
  };
}

/** A failed attempt leaves an explicitly incomplete private copy; the original is never altered. */
export async function createUpstreamStorageCopy(options: UpstreamStorageCopyOptions) {
  const sourcePath = await NodeFSP.realpath(options.source);
  const sourceStat = await NodeFSP.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error("Source must be a database file.");
  const destination = NodePath.resolve(options.destinationDirectory);
  const parent = await NodeFSP.realpath(NodePath.dirname(destination));
  if (destination === NodePath.dirname(sourcePath))
    throw new Error("The copy requires a separate destination directory.");
  await assertHeadroom(parent, sourceStat.size);
  await NodeFSP.mkdir(destination, { mode: 0o700 });
  const output = NodePath.join(destination, "statev2.sqlite");
  const receipt = NodePath.join(destination, "conversion.json");
  await NodeFSP.writeFile(
    receipt,
    JSON.stringify({ status: "incomplete", source: sourcePath, output }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    source.exec("PRAGMA query_only=ON; BEGIN");
    ledger(source);
    if (options.immutableSnapshot) {
      const mode = source.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      if ((sourceStat.mode & 0o222) !== 0 || mode.journal_mode !== "delete")
        throw new Error("A CoW input must be a frozen read-only rollback-journal snapshot.");
      for (const suffix of ["-wal", "-journal"]) {
        if (
          await NodeFSP.lstat(sourcePath + suffix).then(
            () => true,
            () => false,
          )
        )
          throw new Error("Snapshot has a database sidecar.");
      }
      await NodeFSP.copyFile(
        sourcePath,
        output,
        NodeFS.constants.COPYFILE_FICLONE_FORCE | NodeFS.constants.COPYFILE_EXCL,
      );
    } else {
      await NodeSqlite.backup(source, output, { rate: 4096 });
    }
  } finally {
    source.close();
  }
  await NodeFSP.chmod(output, 0o600);
  const db = new NodeSqlite.DatabaseSync(output);
  try {
    const reserve = (bytes: number) => assertHeadroom(destination, bytes);
    const progress = async (stage: string, rows: number) => {
      await assertHeadroom(destination);
      await options.progress?.(stage, rows);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    };
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192",
    );
    db.exec("BEGIN IMMEDIATE");
    const normalized = await normalizeStorageJson(db, progress, reserve);
    db.exec("COMMIT");
    const report = {
      status: "complete",
      source: sourcePath,
      sourceOpenedReadOnly: true,
      output,
      ...normalized,
      sourceBytes: sourceStat.size,
      outputBytes: (await NodeFSP.stat(output)).size,
    };
    await NodeFSP.writeFile(receipt, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return report;
  } finally {
    db.close();
  }
}
