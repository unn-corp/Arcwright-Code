import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Restore latest_turn_id from each thread's most recent real turn because upgrade does not rebuild
 * projections. Exclude imported turns, matching the live path.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turn.turn_id
      FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
        AND turn.turn_id IS NOT NULL
        AND turn.turn_id NOT LIKE 'import:%'
      ORDER BY turn.requested_at DESC, turn.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = projection_threads.thread_id
          AND turn.turn_id IS NOT NULL
          AND turn.turn_id NOT LIKE 'import:%'
      )
  `;
});
