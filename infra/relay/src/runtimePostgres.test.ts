import * as PgClient from "@effect/sql-pg/PgClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlConnection from "effect/sql/SqlConnection";

import { deferDatabase, transactionActive } from "./runtimePostgres.ts";

const fixture = (statements: string[], closed: () => void) => {
  const execute = (sql: string) =>
    Effect.sync(() => {
      statements.push(sql);
      return [];
    });
  const connection: SqlConnection.Connection = {
    execute,
    executeRaw: execute,
    executeStream: () => Stream.empty,
    executeValues: execute,
    executeValuesUnprepared: execute,
    executeUnprepared: execute,
  };
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(closed));
    const client = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer));
    return { $client: client };
  });
};

it.effect("detects the deferred client's transaction and clears it after COMMIT", () =>
  Effect.gen(function* () {
    const statements: string[] = [];
    const db = yield* deferDatabase(fixture(statements, () => {}));
    const states = yield* Effect.scoped(
      Effect.gen(function* () {
        const before = yield* transactionActive(db);
        const during = yield* db.$client.withTransaction(
          Effect.gen(function* () {
            const active = yield* transactionActive(db);
            yield* db.$client`SELECT 1`;
            return active;
          }),
        );
        return [before, during, yield* transactionActive(db)];
      }),
    );
    expect(states).toEqual([false, true, false]);
    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  }),
);

it.effect("keeps one lazy pool per execution scope and closes each pool", () =>
  Effect.gen(function* () {
    let built = 0;
    let closed = 0;
    const db = yield* deferDatabase(
      Effect.suspend(() => {
        built++;
        return fixture([], () => closed++);
      }),
    );
    expect(built).toBe(0);
    for (let execution = 1; execution <= 2; execution++) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(yield* transactionActive(db)).toBe(false);
          expect(yield* db.$client.withTransaction(transactionActive(db))).toBe(true);
          expect(built).toBe(execution);
        }),
      );
      expect(closed).toBe(execution);
    }
  }),
);

it.effect("also checks concrete clients and clears deferred transactions after rollback", () =>
  Effect.gen(function* () {
    const statements: string[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const concrete = yield* fixture([], () => {});
        expect(yield* transactionActive(concrete)).toBe(false);
        expect(yield* concrete.$client.withTransaction(transactionActive(concrete))).toBe(true);

        const db = yield* deferDatabase(fixture(statements, () => {}));
        const failure = yield* db.$client
          .withTransaction(
            Effect.gen(function* () {
              expect(yield* transactionActive(db)).toBe(true);
              return yield* Effect.fail("fixture-rollback");
            }),
          )
          .pipe(Effect.flip);
        expect(failure).toBe("fixture-rollback");
        expect(yield* transactionActive(db)).toBe(false);
      }),
    );
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
  }),
);
