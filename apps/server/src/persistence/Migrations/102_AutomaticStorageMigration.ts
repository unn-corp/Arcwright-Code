import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every older persistent database gets the same durable migration request. Empty homes already use compressed writes.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE arcwright_storage_migrations (
    version INTEGER PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','complete')),
    completed_at TEXT, before_bytes INTEGER, after_bytes INTEGER
  )`;
  yield* sql`INSERT INTO arcwright_storage_migrations(version,state)
    SELECT 1, CASE WHEN EXISTS(SELECT 1 FROM orchestration_events LIMIT 1)
      OR EXISTS(SELECT 1 FROM projection_thread_activities LIMIT 1)
      OR EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items LIMIT 1)
      THEN 'pending' ELSE 'complete' END`;
});
