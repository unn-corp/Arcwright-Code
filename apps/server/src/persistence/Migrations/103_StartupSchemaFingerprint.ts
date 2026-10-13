import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE arcwright_schema_fingerprint (
    id INTEGER PRIMARY KEY CHECK(id=1), manifest_sha256 TEXT NOT NULL,
    schema_sha256 TEXT NOT NULL, ledger_sha256 TEXT NOT NULL
  )`;
});
