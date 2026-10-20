import { vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, UnknownError } from "effect/sql/SqlError";

import type * as RelayDb from "../db.ts";

const decodeCommit = Schema.decodeUnknownEffect(Schema.Struct({ command: Schema.String }));

// Preserve the actual client, compiler, pool, repositories and transaction
// service. Public makeWithTransaction lends an actual scoped PG connection;
// the only added behavior is a Deferred around the real raw COMMIT dispatch.
export const installCommitBarrier = (
  database: RelayDb.RelayDb["Service"],
  before: Effect.Effect<void>,
  after: Effect.Effect<void>,
) => {
  const client = database.$client;
  const withTransaction = SqlClient.makeWithTransaction({
    transactionService: client.transactionService,
    spanAttributes: [],
    acquireConnection: Effect.flatMap(Scope.make(), (scope) =>
      Scope.provide(client.reserve, scope).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.map((connection) => [scope, connection] as const),
      ),
    ),
    begin: (connection) => connection.executeUnprepared("BEGIN", [], undefined).pipe(Effect.asVoid),
    savepoint: (connection, id) =>
      connection.executeUnprepared(`SAVEPOINT effect_sql_${id}`, [], undefined).pipe(Effect.asVoid),
    commit: Effect.fn("managedEndpointCommitTestFixture.commit")(function* (connection) {
      yield* before;
      const result = yield* decodeCommit(yield* connection.executeRaw("COMMIT", [])).pipe(
        Effect.mapError(
          (cause) => new SqlError({ reason: new UnknownError({ cause, operation: "commit" }) }),
        ),
      );
      if (result.command !== "COMMIT")
        return yield* new SqlError({
          reason: new UnknownError({
            cause: "Fixture transaction did not commit",
            operation: "commit",
          }),
        });
      yield* after;
    }),
    rollback: (connection) =>
      connection.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.asVoid),
    rollbackSavepoint: (connection, id) =>
      connection
        .executeUnprepared(`ROLLBACK TO SAVEPOINT effect_sql_${id}`, [], undefined)
        .pipe(Effect.asVoid),
  });
  return vi.spyOn(client, "withTransaction").mockImplementation(withTransaction);
};
