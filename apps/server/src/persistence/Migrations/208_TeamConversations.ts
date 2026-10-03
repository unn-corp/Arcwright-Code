import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE team_conversation_projects (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_conversation_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state_json TEXT NOT NULL, shell_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE team_conversation_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, event_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX team_conversation_events_aggregate ON team_conversation_events(aggregate_id, sequence)`;
  yield* sql`CREATE TABLE team_conversation_receipts (command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'accepted')`;
});
