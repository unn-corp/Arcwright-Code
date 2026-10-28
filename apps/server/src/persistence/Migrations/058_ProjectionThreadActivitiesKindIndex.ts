import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Startup reconciliation needs a kind-leading activity index. Thread-leading indexes scan all live
 * history and block SQLite/provider status work.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_kind
    ON projection_thread_activities(kind, thread_id)
  `;
});
