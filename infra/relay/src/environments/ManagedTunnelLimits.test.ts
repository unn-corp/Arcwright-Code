import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RelayT3ChatPlan } from "@t3tools/contracts/relay";

import * as RelayDb from "../db.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import {
  publicationFor,
  deniedProviderLayer,
  t3ChatDisabledLayer,
} from "./managedEndpointProviderTestFixture.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import { faultDatabaseLayer } from "./managedEndpointSqlFaultFixture.ts";

const input = {
  userId: "user",
  environmentId: "env",
  hostname: "env.fixture.test",
  tunnelName: "env-tunnel",
};
const faultLayer = (fault: Parameters<typeof faultDatabaseLayer>[0]) =>
  ManagedTunnelLimits.layer.pipe(
    Layer.provideMerge(faultDatabaseLayer(fault)),
    Layer.provide(t3ChatDisabledLayer),
  );

const reserveWithPlan = (input: {
  readonly activeTunnels: number;
  readonly maxTunnels?: number;
  readonly plan: RelayT3ChatPlan | "lookup-fails" | "unconfigured" | null;
  readonly lookups: string[];
}) =>
  Effect.gen(function* () {
    const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
    return yield* limits.reserveAllocation({
      userId: "user",
      environmentId: "env",
      hostname: "env.fixture.test",
      tunnelName: "env-tunnel",
    });
  }).pipe(
    Effect.provide(
      ManagedTunnelLimits.layer.pipe(
        Layer.provide(faultDatabaseLayer(input)),
        Layer.provide(
          Layer.mock(T3ChatAccounts.T3ChatAccounts, {
            available: input.plan !== "unconfigured",
            getLink: ({ userId }) =>
              Effect.sync(() => input.lookups.push(userId)).pipe(
                Effect.andThen(
                  input.plan === "lookup-fails"
                    ? Effect.fail(
                        new T3ChatAccounts.T3ChatRequestFailed({
                          operation: "get-link",
                          cause: new Error("fixture unavailable"),
                        }),
                      )
                    : Effect.succeed(
                        input.plan === null || input.plan === "unconfigured"
                          ? null
                          : { email: "fixture@example.test", plan: input.plan },
                      ),
                ),
              ),
          }),
        ),
      ),
    ),
  );

describe("ManagedTunnelLimits account entitlements", () => {
  it.effect("skips account lookups below capacity and enforces exact manual overrides", () =>
    Effect.gen(function* () {
      const lookups: string[] = [];
      expect(yield* reserveWithPlan({ activeTunnels: 2, plan: "premier", lookups })).toMatchObject({
        userId: "user",
        environmentId: "env",
        lifecycleState: "idle",
      });
      for (const maxTunnels of [1, 200]) {
        const error = yield* Effect.flip(
          reserveWithPlan({ activeTunnels: maxTunnels, maxTunnels, plan: "premier", lookups }),
        );
        expect(error).toMatchObject({
          _tag: "ManagedTunnelLimitExceeded",
          maxTunnels,
          activeTunnels: maxTunnels,
        });
      }
      expect(lookups).toEqual([]);
    }),
  );

  it.effect.each([
    ["pro", 10],
    ["premier", 100],
  ] as const)("%s permits its final slot and rejects the next at %s", ([plan, limit]) =>
    Effect.gen(function* () {
      const lookups: string[] = [];
      expect(yield* reserveWithPlan({ activeTunnels: limit - 1, plan, lookups })).toMatchObject({
        userId: "user",
        environmentId: "env",
      });
      const error = yield* Effect.flip(reserveWithPlan({ activeTunnels: limit, plan, lookups }));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitExceeded",
        maxTunnels: limit,
        activeTunnels: limit,
      });
      expect(lookups).toEqual(["user", "user"]);
    }),
  );

  it.effect.each(["free", "lookup-fails", "unconfigured", null] as const)(
    "%s retains the default cap",
    (plan) =>
      Effect.gen(function* () {
        const lookups: string[] = [];
        const error = yield* Effect.flip(reserveWithPlan({ activeTunnels: 3, plan, lookups }));
        expect(error).toMatchObject({
          _tag: "ManagedTunnelLimitExceeded",
          maxTunnels: 3,
          activeTunnels: 3,
        });
        expect(lookups).toEqual(plan === "unconfigured" ? [] : ["user"]);
      }),
  );
});

describe("ManagedTunnelLimits transaction failures", () => {
  it.effect.each([
    { failAt: "BEGIN", operation: "transaction" },
    { failAt: "ISOLATION", operation: "transaction" },
    { failAt: "pg_advisory_xact_lock", operation: "lock" },
    { failAt: 'from "relay_managed_endpoint_allocations"', operation: "load-allocation" },
    { failAt: 'from "relay_managed_tunnel_limits"', operation: "load-limit" },
    { failAt: "count(*)", operation: "count-tunnels" },
    { failAt: "insert into", operation: "insert-allocation" },
    { failAt: "COMMIT", operation: "transaction" },
  ])("fails closed on $failAt", ({ failAt, operation }) =>
    Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(limits.reserveAllocation(input));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation,
        userId: "user",
      });
    }).pipe(Effect.provide(faultLayer({ failAt }))),
  );

  it.effect("maps commit defects before returning the reservation", () =>
    Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(limits.reserveAllocation(input));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "transaction",
      });
    }).pipe(Effect.provide(faultLayer({ defectAt: "COMMIT" }))),
  );

  it.effect("reports an unresolved insert", () =>
    Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(limits.reserveAllocation(input));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "resolve-reservation",
      });
    }).pipe(Effect.provide(faultLayer({ emptyInsert: true }))),
  );

  it.effect("rejects ambient transaction entry before any admission SQL", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* db.$client.withTransaction(Effect.flip(limits.reserveAllocation(input)));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "transaction",
      });
      expect(calls).toEqual(["BEGIN", "COMMIT"]);
    }).pipe(Effect.provide(faultLayer({ calls })));
  });
});

describe("Managed endpoint provider SQL faults", () => {
  it.effect.each(
    [
      { failAt: "BEGIN" },
      { failAt: "ISOLATION" },
      { failAt: "pg_advisory_xact_lock" },
      { failAt: 'from "relay_managed_endpoint_allocations"' },
      { failAt: 'from "relay_managed_tunnel_limits"' },
      { failAt: "count(*)" },
      { failAt: "insert into" },
      { failAt: "COMMIT" },
      { defectAt: "COMMIT" },
      { failAt: "ROLLBACK", emptyInsert: true },
    ].map((fault) => ({ name: fault.failAt ?? fault.defectAt, fault })),
  )("performs zero Cloudflare calls for $name", ({ fault }) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const provider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
      const error = yield* Effect.flip(
        provider.provision({
          userId: "user",
          environmentId: "env",
          origin: { localHttpHost: "localhost", localHttpPort: 3000 },
          publication: publicationFor("env"),
        }),
      );
      expect(error).toMatchObject({
        _tag: "ManagedEndpointProvisioningFailed",
        stage: "reserve-allocation",
      });
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(deniedProviderLayer(faultDatabaseLayer(fault), calls)));
  });
});
