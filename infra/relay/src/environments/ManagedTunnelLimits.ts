import { and, count, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { transactionActive } from "../runtimePostgres.ts";
import {
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import type { ManagedEndpointAllocation } from "./ManagedEndpointAllocations.ts";
import { allocationSelection } from "./managedEndpointAllocationSelection.ts";

/** All held reservations count, including incomplete and released allocations. */
export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;

export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals([
      "transaction",
      "lock",
      "load-allocation",
      "load-limit",
      "count-tunnels",
      "insert-allocation",
      "resolve-reservation",
    ]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class ManagedTunnelLimitExceeded extends Schema.TaggedError<ManagedTunnelLimitExceeded>()(
  "ManagedTunnelLimitExceeded",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    maxTunnels: Schema.Number,
    // Retained wire name: this is the count of ALL held reservations.
    activeTunnels: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed tunnel limit reached for user '${this.userId}': ${this.activeTunnels} of ${this.maxTunnels} tunnels in use`;
  }
}

const isLimitExceeded = Schema.is(ManagedTunnelLimitExceeded);
const isPersistenceError = Schema.is(ManagedTunnelLimitPersistenceError);

export class ManagedTunnelLimits extends Context.Service<
  ManagedTunnelLimits,
  {
    readonly reserveAllocation: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly hostname: string;
      readonly tunnelName: string;
    }) => Effect.Effect<
      ManagedEndpointAllocation,
      ManagedTunnelLimitExceeded | ManagedTunnelLimitPersistenceError
    >;
  }
>()("t3code-relay/environments/ManagedTunnelLimits") {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedTunnelLimits.of({
    reserveAllocation: Effect.fn("relay.managed_tunnel_limits.reserve_allocation")(
      function* (input) {
        const persistenceError = (
          operation: ManagedTunnelLimitPersistenceError["operation"],
          cause: unknown,
        ) => new ManagedTunnelLimitPersistenceError({ operation, userId: input.userId, cause });
        const persist = <A, E, R>(
          operation: ManagedTunnelLimitPersistenceError["operation"],
          effect: Effect.Effect<A, E, R>,
        ) =>
          effect.pipe(
            Effect.mapError((cause) => persistenceError(operation, cause)),
            Effect.catchDefect((cause) => Effect.fail(persistenceError(operation, cause))),
          );

        // A nested withTransaction is only a savepoint and returns before COMMIT.
        // Provider work must start only after this reservation's own COMMIT succeeds.
        if (yield* transactionActive(db)) {
          return yield* persistenceError(
            "transaction",
            new Error("Ambient SQL transaction rejected"),
          );
        }
        return yield* db.$client
          .withTransaction(
            Effect.gen(function* () {
              yield* persist(
                "transaction",
                db.$client`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`,
              );
              // Separate statements ensure the reads get a fresh post-wait snapshot.
              yield* persist(
                "lock",
                db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${input.userId}`}, 0))`,
              );
              const existing = yield* persist(
                "load-allocation",
                db
                  .select(allocationSelection)
                  .from(relayManagedEndpointAllocations)
                  .where(
                    and(
                      eq(relayManagedEndpointAllocations.userId, input.userId),
                      eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
                    ),
                  )
                  .limit(1),
              );
              if (existing[0]) return existing[0];

              const overrides = yield* persist(
                "load-limit",
                db
                  .select({ maxTunnels: relayManagedTunnelLimits.maxTunnels })
                  .from(relayManagedTunnelLimits)
                  .where(eq(relayManagedTunnelLimits.userId, input.userId))
                  .limit(1),
              );
              const maxTunnels = overrides[0]?.maxTunnels ?? DEFAULT_MANAGED_TUNNEL_LIMIT;
              const counted = yield* persist(
                "count-tunnels",
                db
                  .select({ activeTunnels: count() })
                  .from(relayManagedEndpointAllocations)
                  .where(eq(relayManagedEndpointAllocations.userId, input.userId)),
              );
              const activeTunnels = counted[0]?.activeTunnels ?? 0;
              if (activeTunnels >= maxTunnels) {
                return yield* new ManagedTunnelLimitExceeded({
                  userId: input.userId,
                  environmentId: input.environmentId,
                  maxTunnels,
                  activeTunnels,
                });
              }
              const now = DateTime.formatIso(yield* DateTime.now);
              const inserted = yield* persist(
                "insert-allocation",
                db
                  .insert(relayManagedEndpointAllocations)
                  .values({
                    ...input,
                    lifecycleState: "idle",
                    createdAt: now,
                    updatedAt: now,
                  })
                  .returning(allocationSelection),
              );
              if (!inserted[0]) {
                return yield* persistenceError(
                  "resolve-reservation",
                  new Error("INSERT returned no allocation"),
                );
              }
              return inserted[0];
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isLimitExceeded(cause) || isPersistenceError(cause)
                ? cause
                : persistenceError("transaction", cause),
            ),
            // The installed SQL coordinator reports COMMIT/ROLLBACK failures as defects.
            Effect.catchDefect((cause) => Effect.fail(persistenceError("transaction", cause))),
          );
      },
    ),
  });
});

export const layer = Layer.effect(ManagedTunnelLimits, make);
