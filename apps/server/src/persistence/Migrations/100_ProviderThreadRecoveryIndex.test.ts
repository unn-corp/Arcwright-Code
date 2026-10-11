import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("upgrades existing provider histories once without rewriting their payloads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 99 });
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES
        ('active', 'thread:active', 'codex', 'active', '2026-01-01', '{}'),
        ('roster', 'thread:roster', 'codex', 'idle', '2026-01-01', '{"pendingBackgroundTasks":[{"taskId":"work"}]}'),
        ('settled', 'thread:settled', 'codex', 'idle', '2026-01-01', '{"pendingBackgroundTasks":[]}'),
        ('malformed', 'thread:malformed', 'codex', 'idle', '2026-01-01', '{broken')`;
    const before =
      yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`;
    assert.deepEqual(yield* runMigrations(), [[100, "ProviderThreadRecoveryIndex"]]);
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(
      yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`,
      before,
    );
    const pending = yield* sql<{ readonly provider_thread_id: string }>`
      SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
      INDEXED BY orchestration_v2_projection_provider_threads_recovery_idx
      WHERE status = 'active'
        OR CASE WHEN json_valid(payload_json)
          THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
          ELSE 0 END
      ORDER BY provider_thread_id`;
    assert.deepEqual(
      pending.map((row) => row.provider_thread_id),
      ["active", "roster"],
    );
  }).pipe(Effect.provide(layer)),
);
