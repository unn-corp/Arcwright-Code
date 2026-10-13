import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { compressText } from "@t3tools/shared/forkStorageCodec";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect.each([101, 102, 106])(
  "queues compact blocks once for archived history from migration %i",
  (previous) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: previous });
      const blob = compressText('{"text":"kept history"}');
      yield* sql`INSERT INTO arcwright_history_rows VALUES('projection_thread_activities','old-record','old-thread',NULL,${blob.digest},${blob.rawBytes},${blob.compressed})`;
      if (previous >= 102)
        yield* sql`UPDATE arcwright_storage_migrations SET state='complete' WHERE version=1`;
      yield* runMigrations();
      assert.deepEqual(yield* sql`SELECT state FROM arcwright_storage_migrations WHERE version=2`, [
        { state: "pending" },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM arcwright_history_blocks`, []);
      assert.equal(
        (yield* sql`SELECT arcwright_history_json(digest,raw_bytes,compressed) AS json FROM arcwright_history_rows`)[0]!
          .json,
        '{"text":"kept history"}',
      );
      yield* sql`UPDATE arcwright_storage_migrations SET state='complete',before_bytes=10000,after_bytes=2000 WHERE version=2`;
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(
        yield* sql`SELECT state,before_bytes,after_bytes FROM arcwright_storage_migrations WHERE version=2`,
        [{ state: "complete", before_bytes: 10000, after_bytes: 2000 }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
