// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { createUpstreamStorageCopy } from "./upstreamStorageCopy.ts";
import { compressText, payloadReference, storageSchema } from "./forkStorageCodec.ts";
import { archiveRow } from "./forkStorageArchive.ts";

async function fixture(run: (source: string, root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "upstream-storage-copy-"));
  try {
    await NodeFSP.mkdir(NodePath.join(root, "source"));
    const source = NodePath.join(root, "source", "statev2.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec(`CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY,name TEXT,created_at TEXT);
      INSERT INTO effect_sql_migrations VALUES(55,'ProjectionThreadMessageContext','2026-01-01');
      CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,stream_id TEXT,event_type TEXT,payload_json TEXT,payload_bytes INTEGER);
      CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT PRIMARY KEY,payload_json TEXT);
      CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY,aggregate_id TEXT,result_json TEXT);
      CREATE TABLE organization_state(id TEXT PRIMARY KEY,authority TEXT);
      INSERT INTO organization_state VALUES('retained','do not alter');`);
    for (const statement of storageSchema) db.exec(statement);
    db.close();
    await run(source, root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const fileHash = async (filename: string) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(filename))
    .digest("hex");

describe("upstream storage copy", () => {
  it("expands legacy blobs and prompt anchors without changing source, metadata, or fork state", async () => {
    await fixture(async (source, root) => {
      const db = new NodeSqlite.DatabaseSync(source);
      const json = JSON.stringify({ prompt: "Exact Unicode 🧰 prompt", progress: "Working" });
      const blob = compressText(json);
      db.prepare("INSERT INTO arcwright_payload_blobs VALUES(?,?,?)").run(
        blob.digest,
        blob.rawBytes,
        blob.compressed,
      );
      db.prepare("INSERT INTO orchestration_events VALUES(1,'thread','subagent.updated',?,?)").run(
        payloadReference(blob),
        blob.rawBytes,
      );
      db.prepare(
        "INSERT INTO orchestration_events VALUES(2,'thread','subagent.updated',?,NULL)",
      ).run(JSON.stringify({ prompt: "", promptSequence: 1, progress: "Done" }));
      db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES('tool',?)").run(
        payloadReference(blob),
      );
      db.close();
      const original = await fileHash(source);
      const result = await createUpstreamStorageCopy({
        source,
        destinationDirectory: NodePath.join(root, "output"),
      });
      expect(result.schemaUnchanged).toBe(true);
      expect(result.ledgerUnchanged).toBe(true);
      expect(result.promptsExpanded).toBe(1);
      expect(result.payloadsExpanded.orchestration_events).toBe(1);
      const copy = new NodeSqlite.DatabaseSync(result.output, { readOnly: true });
      try {
        expect(
          copy
            .prepare(
              "SELECT json_extract(payload_json,'$.prompt') AS prompt FROM orchestration_events ORDER BY sequence",
            )
            .all(),
        ).toEqual([{ prompt: "Exact Unicode 🧰 prompt" }, { prompt: "Exact Unicode 🧰 prompt" }]);
        expect(
          copy.prepare("SELECT payload_json FROM orchestration_v2_projection_turn_items").get(),
        ).toEqual({ payload_json: json });
        expect(copy.prepare("SELECT * FROM organization_state").get()).toEqual({
          id: "retained",
          authority: "do not alter",
        });
        expect(
          copy.prepare("SELECT name FROM effect_sql_migrations WHERE migration_id=55").get(),
        ).toEqual({ name: "ProjectionThreadMessageContext" });
        expect(copy.prepare("SELECT COUNT(*) AS count FROM arcwright_payload_blobs").get()).toEqual(
          { count: 1 },
        );
      } finally {
        copy.close();
      }
      expect(await fileHash(source)).toBe(original);
    });
  });

  it("restores archived receipts without deleting their retained copies", async () => {
    await fixture(async (source, root) => {
      const db = new NodeSqlite.DatabaseSync(source);
      archiveRow(db, "orchestration_command_receipts", "old-command", "thread", {
        command_id: "old-command",
        aggregate_id: "thread",
        result_json: '{"original":true}',
      });
      db.close();
      const result = await createUpstreamStorageCopy({
        source,
        destinationDirectory: NodePath.join(root, "output"),
      });
      expect(result.archiveRowsRestored.orchestration_command_receipts).toBe(1);
      expect(result.tableRowsAfter.arcwright_history_rows).toBe(1);
      const copy = new NodeSqlite.DatabaseSync(result.output, { readOnly: true });
      try {
        expect(
          copy.prepare("SELECT result_json FROM orchestration_command_receipts").get(),
        ).toEqual({ result_json: '{"original":true}' });
      } finally {
        copy.close();
      }
    });
  });

  it.each(["corrupt-blob", "missing-anchor", "conflicting-archive"])(
    "refuses %s and leaves the original intact",
    async (failure) => {
      await fixture(async (source, root) => {
        const db = new NodeSqlite.DatabaseSync(source);
        if (failure === "corrupt-blob") {
          const blob = compressText('{"text":"original"}');
          db.prepare("INSERT INTO arcwright_payload_blobs VALUES(?,?,x'00')").run(
            blob.digest,
            blob.rawBytes,
          );
          db.prepare("INSERT INTO orchestration_events VALUES(1,'thread','tool',?,NULL)").run(
            payloadReference(blob),
          );
        } else if (failure === "missing-anchor") {
          db.prepare(
            "INSERT INTO orchestration_events VALUES(1,'thread','subagent.updated',?,NULL)",
          ).run('{"prompt":"","promptSequence":999}');
        } else {
          archiveRow(db, "orchestration_command_receipts", "command", "thread", {
            command_id: "command",
            aggregate_id: "thread",
            result_json: "old",
          });
          db.exec("INSERT INTO orchestration_command_receipts VALUES('command','thread','new')");
        }
        db.close();
        const original = await fileHash(source);
        await expect(
          createUpstreamStorageCopy({
            source,
            destinationDirectory: NodePath.join(root, "output"),
          }),
        ).rejects.toThrow();
        expect(await fileHash(source)).toBe(original);
        expect(
          JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "output", "conversion.json"), "utf8"),
          ).status,
        ).toBe("incomplete");
      });
    },
  );

  it("never overwrites an existing destination", async () => {
    await fixture(async (source, root) => {
      const destinationDirectory = NodePath.join(root, "output");
      await NodeFSP.mkdir(destinationDirectory);
      await NodeFSP.writeFile(NodePath.join(destinationDirectory, "keep"), "existing");
      await expect(createUpstreamStorageCopy({ source, destinationDirectory })).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(destinationDirectory, "keep"), "utf8")).toBe(
        "existing",
      );
    });
  });

  it("refuses to treat a writable source as an immutable snapshot", async () => {
    await fixture(async (source, root) => {
      await expect(
        createUpstreamStorageCopy({
          source,
          destinationDirectory: NodePath.join(root, "output"),
          immutableSnapshot: true,
        }),
      ).rejects.toThrow(/frozen read-only/);
    });
  });
});
