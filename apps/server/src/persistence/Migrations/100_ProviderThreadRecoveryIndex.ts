import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Startup and maintenance discover unfinished provider work repeatedly.
  // Keep stopped histories out of those reads, including their JSON rosters.
  yield* sql`CREATE INDEX orchestration_v2_projection_provider_threads_recovery_idx
    ON orchestration_v2_projection_provider_threads(provider_thread_id, thread_id, owner_node_id)
    WHERE status = 'active'
      OR CASE WHEN json_valid(payload_json)
        THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
        ELSE 0 END`;
});
