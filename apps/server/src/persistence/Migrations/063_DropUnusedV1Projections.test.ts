import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
layer("063_DropUnusedV1Projections", (it) => {
  it.effect("preserves fork history, checkpoint data and pending archival through upgrade", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 101 });
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES ('activity-1', 'thread-1', 'tool', 'command', 'Retained history', '{"output":"saved"}', '2026-01-01')`;
      yield* sql`INSERT INTO checkpoint_diff_blobs
        (thread_id, from_turn_count, to_turn_count, diff, created_at)
        VALUES ('thread-1', 0, 1, 'retained diff', '2026-01-01')`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT summary, payload_json FROM projection_thread_activities`, [
        { summary: "Retained history", payload_json: '{"output":"saved"}' },
      ]);
      assert.deepEqual(yield* sql`SELECT diff FROM checkpoint_diff_blobs`, [
        { diff: "retained diff" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT state FROM arcwright_storage_migrations WHERE version = 1`,
        [{ state: "pending" }],
      );
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 110 ORDER BY migration_id`,
        [
          { migration_id: 110, name: "DropUnusedV1Projections" },
          { migration_id: 111, name: "CanonicalizeThreadPullRequestLinks" },
          { migration_id: 112, name: "CodexUsageNativeTurnIndex" },
          { migration_id: 113, name: "RepairClientSettlementTimestamps" },
          { migration_id: 114, name: "WebhookDedupe" },
          { migration_id: 115, name: "ShellStopRequestIndex" },
          { migration_id: 116, name: "ThreadMessageSearch" },
          { migration_id: 117, name: "PeerLinks" },
          { migration_id: 118, name: "PeerLinkFence" },
          { migration_id: 119, name: "WaitingLinkRequestIndex" },
        ],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
