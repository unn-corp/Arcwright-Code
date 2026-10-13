import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PgDialect } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayManagedEndpointAllocations } from "../persistence/schema.ts";
import { settledAllocationFacts } from "./managedEndpointProviderTestFixture.ts";
import * as ManagedEndpointAllocations from "./ManagedEndpointAllocations.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  ManagedEndpointAllocations.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

describe("ManagedEndpointAllocations", () => {
  it.effect("returns recovery support with tunnel allocation lookups", () => {
    const base = {
      userId: "user-1",
      hostname: "environment.example.test",
      tunnelName: "managed-tunnel",
      dnsRecordId: "dns-1",
      readyAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      generation: 1,
    };
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            leftJoin: () => ({
              where: () =>
                Effect.succeed([
                  {
                    ...base,
                    environmentId: "environment-1",
                    tunnelId: "tunnel-1",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "current-key",
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-2",
                    tunnelId: "tunnel-2",
                    recoveryEnabledAt: null,
                    recoveryEnvironmentPublicKey: null,
                    linkedEnvironmentPublicKey: "current-key",
                  },
                  {
                    ...base,
                    environmentId: "environment-3",
                    tunnelId: "tunnel-3",
                    recoveryEnabledAt: "2026-08-25T12:00:00.000Z",
                    recoveryEnvironmentPublicKey: "old-key",
                    linkedEnvironmentPublicKey: "new-key",
                  },
                ]),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const result = yield* allocations.listByTunnelNames([
        "first-tunnel",
        "second-tunnel",
        "third-tunnel",
      ]);

      expect(result.map((entry) => [entry.tunnelId, entry.recoveryEnabled])).toEqual([
        ["tunnel-1", true],
        ["tunnel-2", false],
        ["tunnel-3", false],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("skips the database for an empty tunnel lookup", () =>
    Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(yield* allocations.listByTunnelNames([])).toEqual([]);
    }).pipe(Effect.provide(layerWithDb({} as RelayDb.RelayDb["Service"]))),
  );

  it.effect("splits large tunnel lookups into bounded database queries", () => {
    const batchSizes: number[] = [];
    const fakeDb = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: (condition: unknown) => {
              batchSizes.push(new PgDialect().sqlToQuery(condition as never).params.length);
              return Effect.succeed([]);
            },
          }),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const names = Array.from({ length: 1_001 }, (_, index) => `tunnel-${index}`);
      expect(yield* allocations.listByTunnelNames(names)).toEqual([]);
      expect(batchSizes).toEqual([500, 500, 1]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("retains database failures with allocation operation and identity", () => {
    const cause = new Error("database unavailable");
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayManagedEndpointAllocations);
          return {
            where: () => ({
              limit: () => Effect.fail(cause),
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.get({ userId: "user-1", environmentId: "environment-1" }),
      );

      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "get",
        stage: "database-request",
        userId: "user-1",
        environmentId: "environment-1",
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
  it.each([
    "owned",
    "uncertain",
    "legacy_unverified",
    "cleanup",
    "pending",
    "unresolved",
    "wrong-target",
  ] as const)("denies an unsafe %s allocation in the shared readiness projection", (state) => {
    const allocation: ManagedEndpointAllocations.ManagedEndpointAllocation = {
      ...settledAllocationFacts("tunnel"),
      userId: "user",
      environmentId: "env",
      hostname: "env.fixture.test",
      tunnelId: "tunnel",
      tunnelName: "name",
      dnsRecordId: "dns",
      readyAt: "ready",
      origin: { localHttpHost: "localhost", localHttpPort: 3000 },
      updatedAt: "now",
      generation: 1,
      tunnelReleasedAt: null,
      ...(state === "owned" || state === "uncertain" || state === "legacy_unverified"
        ? { lifecycleState: state }
        : {}),
      ...(state === "cleanup" ? { cleanupRequested: true } : {}),
      ...(state === "pending"
        ? {
            pendingMutation: {
              action: "create_tunnel",
              tunnelName: "name",
              stepId: "00000000-0000-4000-8000-000000000001",
            } as const,
          }
        : {}),
      ...(state === "unresolved" ? { tunnelPresence: "unresolved" as const } : {}),
      ...(state === "wrong-target" ? { dnsTargetTunnelId: "foreign" } : {}),
    };
    expect(
      ManagedEndpointAllocations.resolveReadyManagedEndpoint({
        allocation,
        baseDomain: "fixture.test",
      }),
    ).toBeNull();
  });
  it("retains settled released/offline endpoint identity in the shared projection", () => {
    const allocation: ManagedEndpointAllocations.ManagedEndpointAllocation = {
      ...settledAllocationFacts("tunnel"),
      userId: "user",
      environmentId: "env",
      hostname: "env.fixture.test",
      tunnelId: "tunnel",
      tunnelName: "name",
      dnsRecordId: "dns",
      readyAt: "ready",
      origin: { localHttpHost: "localhost", localHttpPort: 3000 },
      updatedAt: "now",
      generation: 1,
      tunnelReleasedAt: "released",
      tunnelPresence: "absent",
    };
    expect(
      ManagedEndpointAllocations.resolveReadyManagedEndpoint({
        allocation,
        baseDomain: "fixture.test",
      })?.httpBaseUrl,
    ).toBe("https://env.fixture.test/");
  });
});
