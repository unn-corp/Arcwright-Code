import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { storageSchema } from "@t3tools/shared/forkStorageCodec";

// Startup changes only the small schema. Historical rewrites belong to admitted maintenance.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of storageSchema) yield* sql.unsafe(statement);
  yield* sql`ALTER TABLE orchestration_events ADD COLUMN payload_bytes INTEGER`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});
