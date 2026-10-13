import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import { deniedProviderLayer } from "./managedEndpointProviderTestFixture.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import { faultDatabaseLayer } from "./managedEndpointSqlFaultFixture.ts";

const input = {
  userId: "user",
  environmentId: "env",
  hostname: "env.fixture.test",
  tunnelName: "env-tunnel",
};
const faultLayer = (fault: Parameters<typeof faultDatabaseLayer>[0]) =>
  ManagedTunnelLimits.layer.pipe(Layer.provideMerge(faultDatabaseLayer(fault)));

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
