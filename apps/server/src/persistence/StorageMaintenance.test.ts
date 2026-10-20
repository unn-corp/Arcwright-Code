// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerFromPath } from "./Sqlite.ts";
import { CoordinatorStore } from "@t3tools/shared/forkMaintenanceStore";
import { newJournal } from "@t3tools/shared/forkMaintenanceJournal";
import { createSnapshot, restoreSnapshot } from "@t3tools/shared/forkMaintenanceSnapshot";
import { normalizeStorageHome } from "@t3tools/shared/forkStorageMaintenance";
import {
  archiveLegacyHistory,
  recordLegacyBaselines,
  compressEventHistory,
  compressTurnItemHistory,
} from "@t3tools/shared/forkStorageArchive";
import { PAYLOAD_PREFIX, registerStorageFunctions } from "@t3tools/shared/forkStorageCodec";
import { compactHistoryBlocks } from "../../../../packages/shared/src/forkStorageBlocks.ts";
import { runStorageWorker } from "../maintenance/storageWorker.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

function fixture() {
  return Effect.gen(function* () {
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "arcwright-storage-")),
    );
    roots.push(root);
    const home = NodePath.join(root, "home");
    const database = NodePath.join(home, "userdata", "statev2.sqlite");
    yield* Effect.scoped(Layer.build(layerFromPath(database)));
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(async () => {
      const db = new NodeSqlite.DatabaseSync(database);
      db.prepare(`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,archived_at,deleted_at,payload_json)
    VALUES('complete','fixture-project','Completed import','codex','codex','full-access','default','2026-01-01','2026-01-01',NULL,NULL,?)`).run(
        JSON.stringify({
          id: "complete",
          projectId: "fixture-project",
          title: "Completed import",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-6" },
          createdBy: "user",
          creationSource: "web",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "complete" },
          forkedFrom: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        }),
      );
      db.exec(`INSERT INTO orchestration_v2_legacy_imports VALUES('complete','2026-01-01','2026-01-01','2026-01-01',0,NULL);
    INSERT INTO orchestration_v2_legacy_imports VALUES('incomplete','2026-01-01','2026-01-01',NULL,0,NULL);`);
      for (const thread of ["incomplete", "complete"]) {
        db.prepare(`INSERT INTO projection_thread_activities(activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at)
      VALUES(?,?,NULL,'info','tool','historical output',?,'2026-01-01')`).run(
          `activity-${thread}`,
          thread,
          JSON.stringify({ output: "old output\n".repeat(100_000) }),
        );
        db.prepare(`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES(?,'thread',?,40,'legacy.event','2026-01-01','server',?,'{}',1)`).run(
          `event-${thread}`,
          thread,
          JSON.stringify({ output: "event output\n".repeat(100_000) }),
        );
        db.prepare(`INSERT INTO orchestration_command_receipts(command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error)
      VALUES(?,'thread',?,'legacy','2026-01-01',1,'accepted',?)`).run(
          `receipt-${thread}`,
          thread,
          "historical receipt detail ".repeat(1000),
        );
      }
      db.prepare(`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
    VALUES('reasoning','complete','reasoning','preserved reasoning',0,'2026-01-01','2026-01-01')`).run();
      db.exec("UPDATE arcwright_storage_migrations SET state='pending'");
      registerStorageFunctions(db);
      recordLegacyBaselines(db, "2026-01-01");
      await archiveLegacyHistory(db, "2026-07-01", async () => {});
      await compactHistoryBlocks(db, async () => {});
      await compressEventHistory(db, async () => {});
      await compressTurnItemHistory(db, async () => {});
      db.close();
      const store = await CoordinatorStore.open(NodePath.join(root, "coordinator"));
      await store.register(
        {
          id: "fixture",
          label: "Isolated fixture",
          kind: "standalone",
          homes: [home],
          updateTarget: false,
        },
        now,
      );
      await store.confirmBootstrap();
      await store.observe("fixture", [], now - 600_000);
      await store.observe("fixture", [], now);
      const journal = {
        ...newJournal({
          id: "storage-fixture",
          kind: "update",
          homes: [home],
          previous: { version: "old", artifactSha256: "old" },
          target: { version: "new", artifactSha256: "new" },
          now,
        }),
        storageNormalization: true,
      };
      await store.freeze(journal.id, now, { intent: journal });
      await store.unregister("fixture");
      const snapshot = await createSnapshot(home, journal.id);
      await store.writeJournal({ ...journal, phase: "trial", snapshots: { [home]: snapshot } });
      const trial = await store.issueTrial(journal.id, home);
      await store.register(
        {
          id: "backend",
          label: "Fixture backend",
          kind: "standalone",
          homes: [home],
          updateTarget: false,
        },
        now,
        { trial },
      );
      return { root, home, database, store, journal, snapshot, trial };
    });
  });
}

function storageTest(
  name: string,
  check: (f: Effect.Success<ReturnType<typeof fixture>>) => Promise<void>,
) {
  it.live(name, () =>
    fixture().pipe(
      Effect.flatMap((f) => Effect.promise(() => check(f))),
      Effect.provide(NodeServices.layer),
    ),
  );
}

const normalize = (
  f: Effect.Success<ReturnType<typeof fixture>>,
  progress?: (p: { stage: string; rows: number }) => void | Promise<void>,
) =>
  normalizeStorageHome({
    home: f.home,
    transactionId: f.journal.id,
    store: f.store,
    participantId: "backend",
    ...(progress === undefined ? {} : { progress }),
  });

describe("admitted plain JSON storage restoration", () => {
  storageTest(
    "restores legacy history and exact retry responses, retains recovery data, and resumes idempotently",
    async (f) => {
      const report = await normalize(f);
      expect(report).toMatchObject({
        storageNormalizationVersion: 1,
        schemaUnchanged: true,
        ledgerUnchanged: true,
        integrity: "ok",
        snapshotId: f.snapshot,
        archiveRowsRestored: {
          projection_thread_activities: 1,
          orchestration_events: 1,
          orchestration_command_receipts: 1,
          projection_thread_messages: 1,
        },
      });
      expect(await normalize(f)).toEqual(report);
      const db = new NodeSqlite.DatabaseSync(f.database);
      try {
        expect(
          db
            .prepare("SELECT payload_json FROM projection_thread_activities ORDER BY activity_id")
            .all(),
        ).toEqual([
          { payload_json: JSON.stringify({ output: "old output\n".repeat(100_000) }) },
          { payload_json: JSON.stringify({ output: "old output\n".repeat(100_000) }) },
        ]);
        expect(
          db.prepare("SELECT payload_json FROM orchestration_events ORDER BY sequence").all(),
        ).toEqual([
          { payload_json: JSON.stringify({ output: "event output\n".repeat(100_000) }) },
          { payload_json: JSON.stringify({ output: "event output\n".repeat(100_000) }) },
        ]);
        expect(
          db
            .prepare(
              "SELECT error,status FROM orchestration_command_receipts WHERE command_id='receipt-complete'",
            )
            .get(),
        ).toEqual({ error: "historical receipt detail ".repeat(1000), status: "accepted" });
        expect(
          db
            .prepare("SELECT text FROM projection_thread_messages WHERE message_id='reasoning'")
            .get(),
        ).toEqual({ text: "preserved reasoning" });
        expect(db.prepare("SELECT COUNT(*) AS n FROM arcwright_history_rows").get()!.n).toBe(4);
        expect(
          Number(db.prepare("SELECT COUNT(*) AS n FROM arcwright_payload_blobs").get()!.n),
        ).toBeGreaterThan(0);
        expect(
          db.prepare("SELECT state FROM arcwright_storage_migrations ORDER BY version").all(),
        ).toEqual([{ state: "pending" }, { state: "pending" }]);
        // Restoring archived events must retain SQLite's stream clock high water.
        expect(
          db
            .prepare(
              `INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES('after-normalization','thread','complete',41,'legacy.fixture','2026-01-01','server','{}','{}',1) RETURNING sequence`,
            )
            .get(),
        ).toMatchObject({ sequence: 3 });
      } finally {
        db.close();
      }
      await f.store.unregister("backend");
      await restoreSnapshot(f.home, f.snapshot, "fixture-restore");
      const restored = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(
          restored.prepare("SELECT COUNT(*) AS n FROM projection_thread_activities").get(),
        ).toEqual({ n: 1 });
        expect(
          restored.prepare("SELECT payload_json FROM orchestration_events").get()!.payload_json,
        ).toEqual(expect.stringContaining(PAYLOAD_PREFIX));
        expect(restored.prepare("SELECT COUNT(*) AS n FROM arcwright_storage_runs").get()).toEqual({
          n: 0,
        });
      } finally {
        restored.close();
      }
    },
  );

  storageTest(
    "runs the real packaged CLI child and waits for its durable completion before returning",
    async (f) => {
      const status = await f.store.status(Date.now());
      await runStorageWorker(
        {
          mode: "active",
          store: f.store,
          participantId: "backend",
          coordinatorId: status.coordinatorId,
          home: f.home,
          kind: "standalone",
          updateTarget: false,
          trial: f.trial,
          successorOf: null,
        },
        f.journal.id,
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      );
      const db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT json_extract(report_json,'$.storageNormalizationVersion') AS version FROM arcwright_storage_runs WHERE transaction_id=?",
            )
            .get(f.journal.id),
        ).toEqual({ version: 1 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM projection_thread_activities").get()).toEqual({
          n: 2,
        });
      } finally {
        db.close();
      }
    },
  );

  storageTest(
    "rolls back restored rows and the completion receipt on interruption, then retries successfully",
    async (f) => {
      await expect(
        normalize(f, () => {
          throw new Error("fixture interruption");
        }),
      ).rejects.toThrow("fixture interruption");
      const db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM projection_thread_activities").get()).toEqual({
          n: 1,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM arcwright_storage_runs").get()).toEqual({
          n: 0,
        });
      } finally {
        db.close();
      }
      expect((await f.store.status(Date.now())).fence?.transactionId).toBe(f.journal.id);
      expect(await normalize(f)).toMatchObject({ storageNormalizationVersion: 1 });
    },
  );

  storageTest(
    "rolls back if the transaction changes its authorized snapshot during conversion",
    async (f) => {
      const replacement = await createSnapshot(f.home, f.journal.id);
      await expect(
        normalize(f, async () => {
          await f.store.writeJournal({
            ...f.journal,
            phase: "trial",
            snapshots: { [f.home]: replacement },
          });
        }),
      ).rejects.toThrow("authorization changed");
      const db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS n FROM projection_thread_activities").get()).toEqual({
          n: 1,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM arcwright_storage_runs").get()).toEqual({
          n: 0,
        });
      } finally {
        db.close();
      }
      expect((await f.store.status(Date.now())).fence?.transactionId).toBe(f.journal.id);
    },
  );

  storageTest(
    "refuses corrupt compressed data without admitting writes or leaving partial restoration",
    async (f) => {
      const db = new NodeSqlite.DatabaseSync(f.database);
      db.exec("UPDATE arcwright_payload_blobs SET compressed=x'00'");
      db.close();
      await expect(normalize(f)).rejects.toThrow();
      const retained = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(
          retained.prepare("SELECT COUNT(*) AS n FROM projection_thread_activities").get(),
        ).toEqual({ n: 1 });
        expect(retained.prepare("SELECT COUNT(*) AS n FROM arcwright_storage_runs").get()).toEqual({
          n: 0,
        });
      } finally {
        retained.close();
      }
      expect((await f.store.status(Date.now())).fence?.transactionId).toBe(f.journal.id);
    },
  );

  storageTest(
    "requires the exact action, participant, snapshot and home, and blocks another runtime",
    async (f) => {
      await expect(
        normalizeStorageHome({
          home: f.home,
          transactionId: "other",
          store: f.store,
          participantId: "backend",
        }),
      ).rejects.toThrow("exact authorized");
      await expect(
        normalizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
      ).rejects.toThrow("does not own");
      await f.store.writeJournal({
        ...f.journal,
        phase: "trial",
        storageNormalization: false,
        storageOptimization: true,
        snapshots: { [f.home]: f.snapshot },
      });
      await expect(normalize(f)).rejects.toThrow("exact authorized");
      await f.store.writeJournal({
        ...f.journal,
        phase: "trial",
        snapshots: { [f.home]: f.snapshot },
      });
      const trial = await f.store.issueTrial(f.journal.id, f.home);
      await f.store.register(
        {
          id: "other",
          parentId: "backend",
          label: "Other owner",
          kind: "wsl",
          homes: [f.home],
          updateTarget: false,
        },
        Date.now(),
        { trial },
      );
      await expect(normalize(f)).rejects.toThrow("still owns");
      await f.store.unregister("other");
      await NodeFSP.writeFile(
        NodePath.join(
          f.home,
          "maintenance",
          "restore-points",
          f.snapshot,
          "userdata",
          "statev2.sqlite",
        ),
        "damaged",
      );
      await expect(normalize(f)).rejects.toThrow();
    },
  );

  storageTest(
    "binds a WSL conversion to the exact distribution and its native snapshot",
    async (f) => {
      const journalHome = `wsl:StorageFixture:${f.home}`;
      await f.store.writeJournal({
        ...f.journal,
        phase: "trial",
        homes: [journalHome],
        snapshots: { [journalHome]: f.snapshot },
      });
      const saved = process.env.WSL_DISTRO_NAME;
      try {
        process.env.WSL_DISTRO_NAME = "WrongFixture";
        await expect(normalize(f)).rejects.toThrow("exact authorized");
        process.env.WSL_DISTRO_NAME = "StorageFixture";
        expect(await normalize(f)).toMatchObject({ storageNormalizationVersion: 1 });
      } finally {
        if (saved === undefined) delete process.env.WSL_DISTRO_NAME;
        else process.env.WSL_DISTRO_NAME = saved;
      }
    },
  );

  storageTest(
    "refuses a completed compression receipt in place of JSON conversion authorization",
    async (f) => {
      const db = new NodeSqlite.DatabaseSync(f.database);
      db.prepare("INSERT INTO arcwright_storage_runs VALUES(?,?,?,?)").run(
        f.journal.id,
        "2026-01-01",
        "2026-01-01",
        JSON.stringify({ storageMigrationVersion: 2 }),
      );
      db.close();
      await expect(normalize(f)).rejects.toThrow("fresh admitted transaction");
    },
  );

  storageTest("refuses insufficient expansion space before changing rows", async (f) => {
    const probe = vi
      .mocked(NodeFSP.statfs)
      .mockResolvedValueOnce({ bavail: 1, bsize: 1 } as Awaited<ReturnType<typeof NodeFSP.statfs>>);
    try {
      await expect(normalize(f)).rejects.toThrow("Insufficient free space");
    } finally {
      probe.mockClear();
    }
  });
});
