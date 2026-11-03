import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Per-stream versions, unlike global SQLite sequences, advance without allocation gaps. */
export const historicalEventGapBoundary = Effect.fn("eventHistory.historicalGapBoundary")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly boundary: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS boundary FROM (
      SELECT sequence, stream_version, application_event_version,
        LAG(stream_version) OVER (
          PARTITION BY aggregate_kind, stream_id ORDER BY stream_version
        ) AS preceding_version
      FROM orchestration_events
    ) WHERE preceding_version IS NOT NULL
      AND stream_version > preceding_version + 1
      AND application_event_version = 2
  `.pipe(NodeSqliteClient.readOnly);
    return rows[0]?.boundary ?? 0;
  },
);
