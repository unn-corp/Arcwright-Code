import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationEntries.map(([id]) => id),
        Array.from({ length: 108 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect.each(["missing", "renamed"] as const)(
    "rejects a %s required migration below the ledger high water",
    (kind) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        if (kind === "missing")
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id=107`;
        else
          yield* sql`UPDATE effect_sql_migrations SET name='UnknownHistory' WHERE migration_id=107`;
        const before =
          yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
        const error = yield* runMigrations().pipe(Effect.flip);
        assert.equal(error._tag, "MigrationError");
        if (error._tag !== "MigrationError")
          return assert.fail("Expected ledger integrity MigrationError");
        assert.equal(error.kind, "BadState");
        assert.include(
          error.message,
          kind === "missing" ? "107_CompactHistoryBlocks" : "107_UnknownHistory",
        );
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`,
          before,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades the previous fork schema 103 without renumbering installed history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      const before =
        yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [104, "McpAppModelContext"],
        [105, "ThreadSnapshotWindowIndexes"],
        [106, "PullRequestReviewGuides"],
        [107, "CompactHistoryBlocks"],
        [108, "ThreadFailureLookupIndex"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id <= 103 ORDER BY migration_id`,
        before,
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades fork schema 93 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [94, "ProjectionThreadsAutoSettleDisabledAt"],
        [95, "OrchestrationV2"],
        [96, "RemoveRedundantProjectionIndexes"],
        [97, "ScheduledTaskWebhooks"],
        [98, "WebhookRelayDeliveries"],
        [99, "MessageReplyIndex"],
        [100, "ProviderThreadRecoveryIndex"],
        [101, "LosslessStorage"],
        [102, "AutomaticStorageMigration"],
        [103, "StartupSchemaFingerprint"],
        [104, "McpAppModelContext"],
        [105, "ThreadSnapshotWindowIndexes"],
        [106, "PullRequestReviewGuides"],
        [107, "CompactHistoryBlocks"],
        [108, "ThreadFailureLookupIndex"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 94
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 94, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 95, name: "OrchestrationV2" },
        { migration_id: 96, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 97, name: "ScheduledTaskWebhooks" },
        { migration_id: 98, name: "WebhookRelayDeliveries" },
        { migration_id: 99, name: "MessageReplyIndex" },
        { migration_id: 100, name: "ProviderThreadRecoveryIndex" },
        { migration_id: 101, name: "LosslessStorage" },
        { migration_id: 102, name: "AutomaticStorageMigration" },
        { migration_id: 103, name: "StartupSchemaFingerprint" },
        { migration_id: 104, name: "McpAppModelContext" },
        { migration_id: 105, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 106, name: "PullRequestReviewGuides" },
        { migration_id: 107, name: "CompactHistoryBlocks" },
        { migration_id: 108, name: "ThreadFailureLookupIndex" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});
