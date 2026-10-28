import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";

// Public SQL coordinator + real Drizzle, with a test-only connection for fault
// injection. No mocked counts are used as concurrency evidence.
export const faultDatabaseLayer = (input: {
  readonly failAt?: string;
  readonly defectAt?: string;
  readonly emptyInsert?: boolean;
  readonly calls?: string[];
  readonly activeTunnels?: number;
  readonly maxTunnels?: number;
}) =>
  Layer.effect(
    RelayDb.RelayDb,
    Effect.gen(function* () {
      const run = (query: string): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError> =>
        Effect.suspend(() => {
          input.calls?.push(query);
          if (input.defectAt && query.includes(input.defectAt))
            return Effect.die(new Error("SQL defect"));
          if (input.failAt && query.includes(input.failAt)) {
            return Effect.fail(
              new SqlError({ reason: new UnknownError({ cause: new Error("SQL fault") }) }),
            );
          }
          if (query.startsWith("insert") && !input.emptyInsert)
            return Effect.succeed([
              [
                "00000000-0000-4000-8000-000000000001",
                "idle",
                null,
                null,
                null,
                null,
                false,
                "unresolved",
                "unresolved",
                null,
                null,
                null,
                "user",
                "env",
                "env.fixture.test",
                null,
                "env-tunnel",
                null,
                null,
                null,
                "now",
                0,
                null,
              ],
            ]);
          if (query.includes("count(*)")) return Effect.succeed([[input.activeTunnels ?? 0]]);
          if (query.includes('from "relay_managed_tunnel_limits"'))
            return Effect.succeed(input.maxTunnels === undefined ? [] : [[input.maxTunnels]]);
          return Effect.succeed([]);
        });
      const connection = {
        execute: run,
        executeRaw: run,
        executeValues: run,
        executeValuesUnprepared: run,
        executeUnprepared: run,
        executeStream: () => Stream.die(new Error("unused stream")),
      } satisfies Connection;
      const sql = yield* SqlClient.make({
        acquirer: Effect.succeed(connection),
        compiler: PgClient.makeCompiler(),
        spanAttributes: [],
      });
      const client = PgClient.PgClient.of(
        Object.assign(sql, {
          [PgClient.TypeId]: PgClient.TypeId,
          config: { prepare: false },
          json: () => sql.literal("null"),
          listen: () => Effect.die(new Error("unused listen")),
          notify: () => Effect.void,
        } satisfies Pick<
          PgClient.PgClient,
          typeof PgClient.TypeId | "config" | "json" | "listen" | "notify"
        >),
      );
      return yield* PgDrizzle.makeWithDefaults().pipe(
        Effect.provideService(PgClient.PgClient, client),
      );
    }),
  ).pipe(Layer.provide(Reactivity.layer));
