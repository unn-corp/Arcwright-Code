import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { historyBlockSchema } from "@t3tools/shared/forkStorageCodec";

// Metadata only at startup. Both original and previously optimized homes use the admitted worker.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(historyBlockSchema);
  yield* sql`INSERT INTO arcwright_storage_migrations(version,state)
    SELECT 2, CASE WHEN EXISTS(SELECT 1 FROM arcwright_history_rows LIMIT 1)
      OR EXISTS(SELECT 1 FROM arcwright_storage_migrations WHERE state='pending')
      THEN 'pending' ELSE 'complete' END`;
});
