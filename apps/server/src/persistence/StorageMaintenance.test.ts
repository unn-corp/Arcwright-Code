// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
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
import { optimizeStorageHome } from "@t3tools/shared/forkStorageMaintenance";
import { archiveRow, readArchivedRow } from "@t3tools/shared/forkStorageArchive";
import { registerStorageFunctions } from "@t3tools/shared/forkStorageCodec";
import { runStorageWorker } from "../maintenance/storageWorker.ts";
import { readStorageMigrationStatus } from "@t3tools/shared/forkStorageMigration";

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
      db.exec("UPDATE arcwright_storage_migrations SET state='pending' WHERE version=1");
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
        storageOptimization: true,
      };
      await store.freeze(journal.id, now, { intent: journal });
      await store.unregister("fixture");
      const snapshot = await createSnapshot(home, journal.id);
      await store.writeJournal({ ...journal, phase: "trial", snapshots: { [home]: snapshot } });
      return { root, home, database, store, journal, snapshot };
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

describe("admitted lossless storage optimization", () => {
  storageTest(
    "archives across batch boundaries using a resumable row scan without repeated history sorts",
    async (f) => {
      let db = new NodeSqlite.DatabaseSync(f.database);
      const insert = db.prepare(
        `INSERT INTO projection_thread_activities(activity_id,thread_id,turn_id,tone,kind,summary,payload_json,created_at) VALUES(?,'complete',NULL,'info','tool','batch boundary','{}','2026-01-01')`,
      );
      for (let n = 0; n < 300; n++) insert.run(`reverse-${300 - n}`);
      db.close();
      const snapshot = await createSnapshot(f.home, f.journal.id);
      await f.store.writeJournal({
        ...f.journal,
        phase: "trial",
        snapshots: { [f.home]: snapshot },
      });
      const queries = new Set<string>();
      let baselineQuery = "";
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const spy = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql: string) {
          if (sql.includes("SELECT rowid AS position")) queries.add(sql);
          if (sql.includes("INSERT INTO arcwright_legacy_baselines")) baselineQuery = sql;
          return prepare.call(this, sql);
        });
      try {
        const result = await optimizeStorageHome({
          home: f.home,
          transactionId: f.journal.id,
          store: f.store,
        });
        expect(result.archived).toMatchObject({ projection_thread_activities: 301 });
      } finally {
        spy.mockRestore();
      }
      db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      try {
        expect(queries.size).toBe(5);
        expect(baselineQuery).not.toBe("");
        const baselinePlan = db
          .prepare(`EXPLAIN QUERY PLAN ${baselineQuery}`)
          .all("2026-10-12") as { detail: string }[];
        expect(
          baselinePlan.some((row) =>
            /SEARCH event .*aggregate_kind=\? AND stream_id=\?/.test(row.detail),
          ),
        ).toBe(true);
        for (const sql of queries) {
          const parameters = sql.includes("accepted_at < ?") ? [0, "2026-07-01"] : [0];
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as {
            detail: string;
          }[];
          expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
          expect(plan.some((row) => row.detail.includes("INTEGER PRIMARY KEY (rowid>?)"))).toBe(
            true,
          );
        }
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
        ).toMatchObject({ count: 1 });
        expect(readArchivedRow(db, "projection_thread_activities", "reverse-1")?.summary).toBe(
          "batch boundary",
        );
      } finally {
        db.close();
      }
    },
  );
  storageTest(
    "runs the real CLI as the trial backend's low-priority child and waits for its completed rewrite",
    async (f) => {
      const trial = await f.store.issueTrial(f.journal.id, f.home);
      await f.store.register(
        {
          id: "backend",
          label: "Fixture backend",
          kind: "desktop",
          homes: [f.home],
          updateTarget: true,
        },
        Date.now(),
        { trial },
      );
      const status = await f.store.status(Date.now());
      await runStorageWorker(
        {
          mode: "active",
          store: f.store,
          participantId: "backend",
          coordinatorId: status.coordinatorId,
          home: f.home,
          kind: "desktop",
          updateTarget: true,
          trial,
          successorOf: null,
        },
        f.journal.id,
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
      );
      const db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      expect(
        db
          .prepare("SELECT completed_at FROM arcwright_storage_runs WHERE transaction_id=?")
          .get(f.journal.id),
      ).toMatchObject({ completed_at: expect.any(String) });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
      ).toMatchObject({ count: 1 });
      db.close();
    },
  );
  storageTest(
    "preserves old history, stream clocks, incomplete imports and exact retry responses, then restores the original home",
    async (f) => {
      const report = await optimizeStorageHome({
        home: f.home,
        transactionId: f.journal.id,
        store: f.store,
      });
      expect(report.archived).toMatchObject({
        projection_thread_activities: 1,
        orchestration_events: 1,
        orchestration_command_receipts: 1,
        projection_thread_messages: 1,
      });
      expect(Number(report.afterBytes)).toBeLessThan(Number(report.beforeBytes));
      expect(readStorageMigrationStatus(f.home)).toMatchObject({
        state: "complete",
        beforeBytes: report.beforeBytes,
        afterBytes: report.afterBytes,
      });
      const db = new NodeSqlite.DatabaseSync(f.database);
      registerStorageFunctions(db);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_orch_events_correlation_id','idx_orch_command_receipts_aggregate','idx_orch_command_receipts_sequence')",
          )
          .all(),
      ).toEqual([]);
      expect(readArchivedRow(db, "projection_thread_messages", "reasoning")?.text).toBe(
        "preserved reasoning",
      );
      expect(
        readArchivedRow(db, "orchestration_command_receipts", "receipt-complete")?.status,
      ).toBe("accepted");
      expect(
        db
          .prepare(
            "SELECT stream_version FROM arcwright_legacy_baselines WHERE thread_id='complete'",
          )
          .get(),
      ).toMatchObject({ stream_version: 40 });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
      ).toMatchObject({ count: 1 });
      expect(
        await optimizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
      ).toEqual(report);
      // VACUUM must retain AUTOINCREMENT's high water even when the last legacy event was retired.
      const clock = db
        .prepare(`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES('after-compaction','thread','complete',41,'legacy.fixture','2026-01-01','server','{}','{}',1) RETURNING sequence`)
        .get();
      expect(clock).toMatchObject({ sequence: 3 });
      db.close();
      await restoreSnapshot(f.home, f.snapshot, "fixture-restore");
      const restored = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      expect(
        restored.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
      ).toMatchObject({ count: 2 });
      expect(readStorageMigrationStatus(f.home).state).toBe("pending");
      expect(
        restored
          .prepare("SELECT text FROM projection_thread_messages WHERE message_id='reasoning'")
          .get(),
      ).toMatchObject({ text: "preserved reasoning" });
      restored.close();
    },
  );

  storageTest(
    "refuses an unbound request, a registered active owner and a damaged restore point before rewriting anything",
    async (f) => {
      await expect(
        optimizeStorageHome({ home: f.home, transactionId: "other", store: f.store }),
      ).rejects.toThrow("exact authorized");
      const capability = await f.store.issueTrial(f.journal.id, f.home);
      await f.store.register(
        {
          id: "owner",
          label: "Active trial",
          kind: "standalone",
          homes: [f.home],
          updateTarget: false,
        },
        Date.now(),
        { trial: capability },
      );
      await expect(
        optimizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
      ).rejects.toThrow("still owns");
      await f.store.unregister("owner");
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
      await expect(
        optimizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
      ).rejects.toThrow();
      const db = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
      ).toMatchObject({ count: 2 });
      expect(readStorageMigrationStatus(f.home).state).toBe("pending");
      db.close();
    },
  );

  storageTest(
    "binds a WSL rewrite to the exact distribution home and its native restore point",
    async (f) => {
      const journalHome = `wsl:StorageFixture:${f.home}`;
      await f.store.writeJournal({
        ...f.journal,
        phase: "trial",
        homes: [journalHome],
        snapshots: { [journalHome]: f.snapshot },
      });
      const savedDistro = process.env.WSL_DISTRO_NAME;
      try {
        process.env.WSL_DISTRO_NAME = "WrongFixture";
        await expect(
          optimizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
        ).rejects.toThrow("exact authorized");
        process.env.WSL_DISTRO_NAME = "StorageFixture";
        const report = await optimizeStorageHome({
          home: f.home,
          transactionId: f.journal.id,
          store: f.store,
        });
        expect(Number(report.afterBytes)).toBeLessThan(Number(report.beforeBytes));
        expect(readStorageMigrationStatus(f.home).state).toBe("complete");
      } finally {
        if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
        else process.env.WSL_DISTRO_NAME = savedDistro;
      }
    },
  );

  storageTest("detects a conflicting archive before deleting its source row", async (f) => {
    const db = new NodeSqlite.DatabaseSync(f.database);
    archiveRow(db, "projection_thread_activities", "activity-complete", "complete", {
      wrong: "row",
    });
    db.close();
    await expect(
      optimizeStorageHome({ home: f.home, transactionId: f.journal.id, store: f.store }),
    ).rejects.toThrow("archive verification");
    const retained = new NodeSqlite.DatabaseSync(f.database, { readOnly: true });
    expect(
      retained
        .prepare(
          "SELECT activity_id FROM projection_thread_activities WHERE activity_id='activity-complete'",
        )
        .get(),
    ).toBeDefined();
    retained.close();
    expect((await f.store.status(Date.now())).fence?.transactionId).toBe(f.journal.id);
  });
});
