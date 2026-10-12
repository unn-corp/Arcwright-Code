import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([1, 56, 99, 100, 101])(
  "queues lossless shrink for a populated database from migration %i exactly once",
  (previous) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: previous });
      yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json)
        VALUES('old-output','thread','old-chat',1,'legacy.event','2026-01-01','server','{"output":"original history"}','{}')`;
      const before = yield* sql`SELECT * FROM orchestration_events`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_orch_events_correlation_id','idx_orch_command_receipts_aggregate','idx_orch_command_receipts_sequence') ORDER BY name`,
        [
          { name: "idx_orch_command_receipts_aggregate" },
          { name: "idx_orch_command_receipts_sequence" },
          { name: "idx_orch_events_correlation_id" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT state FROM arcwright_storage_migrations WHERE version=1`, [
        { state: "pending" },
      ]);
      // The startup migration only records the request; heavyweight rewrites require native admission.
      assert.equal(
        (yield* sql`SELECT payload_json FROM orchestration_events`)[0]!.payload_json,
        before[0]!.payload_json,
      );
      yield* sql`UPDATE arcwright_storage_migrations SET state='complete',before_bytes=10000,after_bytes=1000 WHERE version=1`;
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT state,before_bytes,after_bytes FROM arcwright_storage_migrations`,
        [{ state: "complete", before_bytes: 10000, after_bytes: 1000 }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("fresh databases skip historical shrink instead of scheduling repeated repacks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT state FROM arcwright_storage_migrations`, [
      { state: "complete" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
