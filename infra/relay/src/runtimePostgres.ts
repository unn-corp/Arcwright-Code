import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { resolveConnectionOptions } from "alchemy/SQL/PostgresTls";
import { proxyChain } from "alchemy/Util/proxy-chain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";

interface TransactionDatabase {
  readonly $client: Pick<SqlClient.SqlClient, "transactionService">;
  readonly transactionActive?: Effect.Effect<boolean>;
}

/** Concrete fixtures and deferred Worker databases share the same check. */
export const transactionActive = (db: TransactionDatabase): Effect.Effect<boolean> =>
  db.transactionActive ??
  Effect.map(Effect.serviceOption(db.$client.transactionService), Option.isSome);

export const deferDatabase = <A extends TransactionDatabase, E, R>(
  build: Effect.Effect<A, E, R | Scope.Scope>,
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.map(build, (db) =>
        Object.assign(db, {
          // Resolve the tag on the concrete client before the deferred proxy
          // turns synchronous property reads into unevaluated chains.
          transactionActive: Effect.map(
            Effect.serviceOption(db.$client.transactionService),
            Option.isSome,
          ),
        }),
      ),
    ),
    (database) => proxyChain<A & { readonly transactionActive: Effect.Effect<boolean> }>(database),
  );

/** Keep pools lazy and scoped to the current Worker event, as in Alchemy. */
export const runtimePostgres = <E, R>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
) =>
  deferDatabase(
    Effect.gen(function* () {
      // Driver initialization belongs to the event, not the Worker's startup
      // CPU budget. Match Alchemy's deferred imports as well as its pool scope.
      const [PgClient, PgDrizzle] = yield* Effect.promise(() =>
        Promise.all([import("@effect/sql-pg/PgClient"), import("drizzle-orm/effect-postgres")]),
      );
      const url = yield* connectionString;
      const context = yield* Layer.build(
        PgClient.layer({ ...resolveConnectionOptions(url), prepare: false }),
      );
      return yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context));
    }),
  );
