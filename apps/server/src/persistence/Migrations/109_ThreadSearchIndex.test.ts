import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("indexes existing finished messages when upgrading 108 to 109", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 108 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES ('old','thread','user',0,'2026-10-16','2026-10-16','{"text":"An EXISTING substring"}'),
        ('stream','thread','assistant',1,'2026-10-16','2026-10-16','{"text":"Still streaming"}')`;
    yield* runMigrations();
    const lookup = (query: string) => sql<{ message_id: string }>`
      SELECT message.message_id FROM orchestration_v2_projection_messages message
      JOIN orchestration_v2_message_search search ON search.rowid=message.rowid
      WHERE orchestration_v2_message_search MATCH ${query}`;
    assert.deepEqual(yield* lookup('"existing"'), [{ message_id: "old" }]);
    assert.deepEqual(yield* lookup('"streaming"'), []);
    yield* sql`UPDATE orchestration_v2_projection_messages SET streaming=0 WHERE message_id='stream'`;
    assert.deepEqual(yield* lookup('"streaming"'), [{ message_id: "stream" }]);
    yield* sql`VACUUM`;
    assert.deepEqual(yield* lookup('"existing"'), [{ message_id: "old" }]);
    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id='old'`;
    assert.deepEqual(yield* lookup('"existing"'), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
