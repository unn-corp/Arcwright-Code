import { describe, expect, it } from "@effect/vitest";
import { count, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { SqlError } from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
} from "../persistence/schema.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import { connectDatabase, fixtureFile, layerDb } from "./managedEndpointPostgresFixture.ts";
import {
  publicationFor,
  deniedProviderLayer,
  t3ChatDisabledLayer,
} from "./managedEndpointProviderTestFixture.ts";

const isPersistenceError = Schema.is(ManagedTunnelLimits.ManagedTunnelLimitPersistenceError);
const isSqlError = Schema.is(SqlError);

const input = (environmentId: string, userId = "user") => ({
  userId,
  environmentId,
  hostname: `${userId}-${environmentId}.fixture.test`,
  tunnelName: `${userId}-${environmentId}`,
});
const layer = Layer.merge(ManagedTunnelLimits.layer, ManagedEndpointAllocations.layer).pipe(
  Layer.provideMerge(layerDb),
  Layer.provideMerge(t3ChatDisabledLayer),
);
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer));
const rowCount = (db: RelayDb.RelayDb["Service"], userId = "user") =>
  db
    .select({ count: count() })
    .from(relayManagedEndpointAllocations)
    .where(eq(relayManagedEndpointAllocations.userId, userId))
    .pipe(Effect.map((rows) => rows[0]?.count ?? 0));
const override = (db: RelayDb.RelayDb["Service"], maxTunnels: number, userId = "user") =>
  db
    .insert(relayManagedTunnelLimits)
    .values({ userId, maxTunnels, createdAt: "now", updatedAt: "now" })
    .onConflictDoUpdate({ target: relayManagedTunnelLimits.userId, set: { maxTunnels } });

const race = <A, E>(effects: ReadonlyArray<Effect.Effect<A, E>>) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const fibers = yield* Effect.forEach(effects, (effect) =>
      Effect.forkChild(Deferred.await(gate).pipe(Effect.andThen(Effect.result(effect)))),
    );
    yield* Deferred.succeed(gate, undefined);
    return yield* Effect.forEach(fibers, Fiber.join);
  });

describe.skipIf(!fixtureFile)("ManagedTunnelLimits owned PostgreSQL admission", () => {
  it.effect.each([
    { plan: null, cap: 3, denied: 17 },
    { plan: "pro", cap: 10, denied: 10 },
  ] as const)(
    "20 concurrent environments with $plan admit exactly $cap reservations",
    ({ plan, cap, denied }) =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const limits =
            plan === null
              ? yield* ManagedTunnelLimits.ManagedTunnelLimits
              : yield* ManagedTunnelLimits.make.pipe(
                  Effect.provideService(T3ChatAccounts.T3ChatAccounts, {
                    available: true,
                    createLinkUrl: () => Effect.die("unused link request"),
                    getLink: () => Effect.succeed({ email: "fixture@example.test", plan }),
                    unlink: () => Effect.die("unused unlink"),
                  }),
                );
          const results = yield* race(
            Array.from({ length: 20 }, (_, i) => limits.reserveAllocation(input(`env-${i}`))),
          );
          expect(results.filter(Result.isSuccess)).toHaveLength(cap);
          const errors = results.filter(Result.isFailure).map((result) => result.failure);
          expect(errors).toHaveLength(denied);
          for (const error of errors)
            expect(error).toMatchObject({
              _tag: "ManagedTunnelLimitExceeded",
              maxTunnels: cap,
              activeTunnels: cap,
            });
          expect(yield* rowCount(db)).toBe(cap);
        }),
      ),
  );

  it.effect("an exact per-user override admits twenty and denies the twenty-first", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        yield* override(db, 20);
        const results = yield* race(
          Array.from({ length: 20 }, (_, i) => limits.reserveAllocation(input(`env-${i}`))),
        );
        expect(results.every(Result.isSuccess)).toBe(true);
        expect(yield* rowCount(db)).toBe(20);
        expect(yield* Effect.flip(limits.reserveAllocation(input("env-21")))).toMatchObject({
          _tag: "ManagedTunnelLimitExceeded",
          maxTunnels: 20,
          activeTunnels: 20,
        });
      }),
    ),
  );

  it.effect("two users get independent default capacities", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        const results = yield* race(
          ["user-A", "user-B"].flatMap((userId) =>
            Array.from({ length: 12 }, (_, i) =>
              limits.reserveAllocation(input(`env-${i}`, userId)),
            ),
          ),
        );
        expect(results.filter(Result.isSuccess)).toHaveLength(6);
        expect(yield* rowCount(db, "user-A")).toBe(3);
        expect(yield* rowCount(db, "user-B")).toBe(3);
      }),
    ),
  );

  it.effect("concurrent same-environment requests return one existing allocation", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        const results = yield* race(
          Array.from({ length: 20 }, () => limits.reserveAllocation(input("same-env"))),
        );
        expect(results.every(Result.isSuccess)).toBe(true);
        expect(yield* rowCount(db)).toBe(1);
        const allocation = yield* limits.reserveAllocation(input("same-env"));
        for (const result of results)
          if (Result.isSuccess(result)) expect(result.success).toEqual(allocation);
      }),
    ),
  );

  it.effect("existing environments reuse their names at capacity and below a lowered limit", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const lookups: string[] = [];
        const limits = yield* ManagedTunnelLimits.make.pipe(
          Effect.provideService(T3ChatAccounts.T3ChatAccounts, {
            available: true,
            createLinkUrl: () => Effect.die("unused link request"),
            getLink: ({ userId }) =>
              Effect.sync(() => lookups.push(userId)).pipe(
                Effect.andThen(
                  Effect.fail(
                    new T3ChatAccounts.T3ChatRequestFailed({
                      operation: "get-link",
                      cause: new Error("fixture unavailable"),
                    }),
                  ),
                ),
              ),
            unlink: () => Effect.die("unused unlink"),
          }),
        );
        const existing = yield* limits.reserveAllocation(input("existing"));
        yield* limits.reserveAllocation(input("two"));
        yield* limits.reserveAllocation(input("three"));
        const requested = {
          ...input("existing"),
          hostname: "different.fixture.test",
          tunnelName: "different",
        };
        expect(yield* limits.reserveAllocation(requested)).toEqual(existing);
        yield* override(db, 1);
        expect(yield* limits.reserveAllocation(requested)).toEqual(existing);
        expect(yield* Effect.flip(limits.reserveAllocation(input("four")))).toMatchObject({
          _tag: "ManagedTunnelLimitExceeded",
          maxTunnels: 1,
          activeTunnels: 3,
        });
        expect(lookups).toEqual([]);
      }),
    ),
  );

  it.effect("all retained states consume capacity across link and credential states", () =>
    fixture(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        const states = [
          { name: "in-flight", tunnelId: null, readyAt: null, tunnelReleasedAt: null },
          { name: "incomplete", tunnelId: "tunnel", readyAt: null, tunnelReleasedAt: null },
          {
            name: "failed-link-or-credential",
            tunnelId: "tunnel",
            readyAt: "ready",
            tunnelReleasedAt: null,
          },
          { name: "offline", tunnelId: "tunnel", readyAt: "ready", tunnelReleasedAt: null },
          {
            name: "unlinked-retained",
            tunnelId: "tunnel",
            readyAt: "ready",
            tunnelReleasedAt: null,
          },
          { name: "released", tunnelId: "tunnel", readyAt: null, tunnelReleasedAt: "released" },
          {
            name: "cleanup-failed",
            tunnelId: "tunnel",
            readyAt: null,
            tunnelReleasedAt: "released",
          },
        ];
        for (const state of states) {
          const userId = state.name;
          yield* db.insert(relayManagedEndpointAllocations).values([
            { ...input("one", userId), createdAt: "now", updatedAt: "now" },
            { ...input("two", userId), createdAt: "now", updatedAt: "now" },
            {
              ...input("state", userId),
              tunnelId: state.tunnelId,
              readyAt: state.readyAt,
              dnsRecordId: state.readyAt === null ? null : "dns",
              origin:
                state.readyAt === null ? null : { localHttpHost: "localhost", localHttpPort: 3000 },
              tunnelReleasedAt: state.tunnelReleasedAt,
              createdAt: "now",
              updatedAt: "now",
            },
          ]);
          if (state.name === "offline" || state.name === "unlinked-retained") {
            // Offline has a live link; retained unlink has a revoked link. No
            // connector status or credential row can release either reservation.
            yield* db.insert(relayEnvironmentLinks).values({
              userId,
              environmentId: "state",
              environmentPublicKey: "fixture-key",
              endpointHttpBaseUrl: `https://${userId}-state.fixture.test`,
              endpointWsBaseUrl: `wss://${userId}-state.fixture.test`,
              endpointProviderKind: "cloudflare_tunnel",
              managedTunnelsEnabled: true,
              revokedAt: state.name === "unlinked-retained" ? "revoked" : null,
              linkedAt: "now",
              createdAt: "now",
              updatedAt: "now",
            });
          }
          expect(yield* Effect.flip(limits.reserveAllocation(input("four", userId)))).toMatchObject(
            { _tag: "ManagedTunnelLimitExceeded", activeTunnels: 3 },
          );
          expect(yield* rowCount(db, userId)).toBe(3);
        }
      }),
    ),
  );

  it.effect(
    "hostname and tunnel-name collisions fail closed without adopting another user's row",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
          const owned = yield* limits.reserveAllocation(input("env", "owner"));
          for (const collision of [
            { hostname: owned.hostname },
            { tunnelName: owned.tunnelName },
          ]) {
            const error = yield* Effect.flip(
              limits.reserveAllocation({ ...input("env", "other"), ...collision }),
            );
            expect(error).toMatchObject({
              _tag: "ManagedTunnelLimitPersistenceError",
              operation: "insert-allocation",
              userId: "other",
            });
          }
          expect(yield* rowCount(db, "other")).toBe(0);
          expect(yield* limits.reserveAllocation(input("env", "owner"))).toEqual(owned);
        }),
      ),
  );

  it.effect("provider denial through real admission performs zero Cloudflare operations", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      for (const env of ["one", "two", "three"]) yield* limits.reserveAllocation(input(env));
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user",
          environmentId: "four",
          origin: { localHttpHost: "localhost", localHttpPort: 3000 },
          publication: publicationFor("four"),
        }),
      );
      expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", activeTunnels: 3 });
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(deniedProviderLayer(layerDb, calls)));
  });

  it.live("SQL contention rolls back, then fresh admission sees the committed winner", () =>
    fixture(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* override(db, 1);
          const contender = Context.get(
            yield* Layer.build(connectDatabase("150ms")),
            RelayDb.RelayDb,
          );
          const contenderLimits = yield* ManagedTunnelLimits.make.pipe(
            Effect.provideService(RelayDb.RelayDb, contender),
          );
          const held = yield* Deferred.make<number>();
          const commit = yield* Deferred.make<void>();
          const owner = yield* Effect.forkChild(
            db.$client.withTransaction(
              Effect.gen(function* () {
                yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended('relay-managed-tunnel:user', 0))`;
                yield* db
                  .insert(relayManagedEndpointAllocations)
                  .values({ ...input("winner"), createdAt: "now", updatedAt: "now" });
                const pid = yield* db.$client<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(held, pid[0]?.pid ?? 0);
                yield* Deferred.await(commit);
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const ownerPid = yield* Deferred.await(held);
            const beforePid = yield* contender.$client<{
              pid: number;
            }>`SELECT pg_backend_pid() AS pid`;
            expect(ownerPid).toBeGreaterThan(0);
            expect(beforePid[0]?.pid).not.toBe(ownerPid);
            const error = yield* Effect.flip(contenderLimits.reserveAllocation(input("waiter")));
            expect(error).toMatchObject({
              _tag: "ManagedTunnelLimitPersistenceError",
              operation: "lock",
            });
            if (!isPersistenceError(error)) throw new Error("Unexpected admission failure");
            expect(isSqlError(error.cause)).toBe(true);
            if (isSqlError(error.cause))
              expect(error.cause.reason).toMatchObject({
                _tag: "LockTimeoutError",
                cause: { code: "55P03" },
              });
            expect(yield* rowCount(contender)).toBe(0);
            const cfCalls: string[] = [];
            const provider = Context.get(
              // Do not reuse the outer fixture's memoized quota service/pool.
              yield* Layer.build(
                Layer.fresh(
                  deniedProviderLayer(Layer.succeed(RelayDb.RelayDb, contender), cfCalls),
                ),
              ),
              ManagedEndpointProvider.ManagedEndpointProvider,
            );
            expect(
              yield* Effect.flip(
                provider.provision({
                  userId: "user",
                  environmentId: "waiter",
                  origin: { localHttpHost: "localhost", localHttpPort: 3000 },
                  publication: publicationFor("waiter"),
                }),
              ),
            ).toMatchObject({
              _tag: "ManagedEndpointProvisioningFailed",
              stage: "reserve-allocation",
            });
            expect(cfCalls).toEqual([]);
            yield* Deferred.succeed(commit, undefined);
            yield* Fiber.join(owner);
            expect(
              yield* Effect.flip(contenderLimits.reserveAllocation(input("waiter"))),
            ).toMatchObject({
              _tag: "ManagedTunnelLimitExceeded",
              maxTunnels: 1,
              activeTunnels: 1,
            });
            const afterPid = yield* contender.$client<{
              pid: number;
            }>`SELECT pg_backend_pid() AS pid`;
            expect(afterPid[0]?.pid).toBe(beforePid[0]?.pid);
            yield* Effect.log("SQL contention plus ordered committed visibility", {
              ownerBackendPid: ownerPid,
              contenderBackendPidBefore: beforePid[0]?.pid,
              contenderBackendPidAfter: afterPid[0]?.pid,
              sqlState: "55P03",
            });
            expect(yield* rowCount(contender)).toBe(1);
          }).pipe(Effect.ensuring(Deferred.succeed(commit, undefined)));
        }),
      ),
    ),
  );
});
