import type { RelayManagedEndpoint, RelayManagedEndpointOrigin } from "@t3tools/contracts/relay";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { allocationSelection } from "./managedEndpointAllocationSelection.ts";
import { isManagedEndpointHostname, managedEndpointForHostname } from "../deploymentConfig.ts";
import { relayEnvironmentLinks, relayManagedEndpointAllocations } from "../persistence/schema.ts";

import type {
  LifecycleState,
  OperationKind,
  PendingMutation,
  ResourcePresence,
} from "./managedEndpointLifecycleContracts.ts";

export interface ManagedEndpointAllocation {
  readonly allocationId: string;
  readonly lifecycleState: LifecycleState;
  readonly operationId: string | null;
  readonly operationKind: OperationKind | null;
  readonly operationStartedAt: string | null;
  readonly pendingMutation: PendingMutation | null;
  readonly cleanupRequested: boolean;
  readonly tunnelPresence: ResourcePresence;
  readonly dnsPresence: ResourcePresence;
  readonly dnsTargetTunnelId: string | null;
  readonly recoveryEnabledAt: string | null;
  readonly recoveryEnvironmentPublicKey: string | null;
  readonly userId: string;
  readonly environmentId: string;
  readonly hostname: string;
  readonly tunnelId: string | null;
  readonly tunnelName: string;
  readonly dnsRecordId: string | null;
  readonly readyAt: string | null;
  readonly origin: RelayManagedEndpointOrigin | null;
  readonly updatedAt: string;
  readonly generation: number;
  readonly tunnelReleasedAt: string | null;
}

export interface ManagedEndpointTunnelAllocation extends ManagedEndpointAllocation {
  readonly recoveryEnabled: boolean;
}

export const MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE = 500;

export function resolveReadyManagedEndpoint(input: {
  readonly allocation: ManagedEndpointAllocation;
  readonly baseDomain: string | undefined;
}): RelayManagedEndpoint | null {
  if (
    !input.baseDomain ||
    input.allocation.lifecycleState !== "idle" ||
    input.allocation.operationId !== null ||
    input.allocation.pendingMutation !== null ||
    input.allocation.cleanupRequested ||
    !["recorded", "absent"].includes(input.allocation.tunnelPresence) ||
    input.allocation.dnsPresence !== "recorded" ||
    input.allocation.dnsTargetTunnelId !== input.allocation.tunnelId ||
    input.allocation.origin === null ||
    input.allocation.readyAt === null ||
    input.allocation.tunnelId === null ||
    input.allocation.dnsRecordId === null ||
    !isManagedEndpointHostname(input.allocation.hostname, input.baseDomain)
  ) {
    return null;
  }
  return managedEndpointForHostname(input.allocation.hostname);
}

export class ManagedEndpointAllocationPersistenceError extends Schema.TaggedError<ManagedEndpointAllocationPersistenceError>()(
  "ManagedEndpointAllocationPersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "record-tunnel",
      "record-dns",
      "mark-ready",
      "enable-recovery",
      "list-tunnels",
      "lock-tunnel",
      "claim-release",
      "claim-deprovision",
      "remove",
      "remove-claimed",
      "get-by-tunnel-name",
    ]),
    stage: Schema.Literals(["database-request", "resolve-reservation"]),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint allocation '${this.operation}' failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

interface ManagedEndpointAllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

export class ManagedEndpointAllocations extends Context.Service<
  ManagedEndpointAllocations,
  {
    readonly get: (
      input: ManagedEndpointAllocationKey,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly getByTunnelName: (
      tunnelName: string,
    ) => Effect.Effect<ManagedEndpointAllocation | null, ManagedEndpointAllocationPersistenceError>;
    readonly listByTunnelNames: (
      tunnelNames: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyArray<ManagedEndpointTunnelAllocation>,
      ManagedEndpointAllocationPersistenceError
    >;
  }
>()("t3code-relay/environments/ManagedEndpointAllocations") {}

const whereAllocation = (input: ManagedEndpointAllocationKey) =>
  and(
    eq(relayManagedEndpointAllocations.userId, input.userId),
    eq(relayManagedEndpointAllocations.environmentId, input.environmentId),
  );

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  return ManagedEndpointAllocations.of({
    get: Effect.fn("relay.managed_endpoint_allocations.get")(function* (
      input: ManagedEndpointAllocationKey,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(whereAllocation(input))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get",
                stage: "database-request",
                ...input,
                cause,
              }),
          ),
        );
    }),
    getByTunnelName: Effect.fn("relay.managed_endpoint_allocations.get_by_tunnel_name")(function* (
      tunnelName: string,
    ) {
      return yield* db
        .select(allocationSelection)
        .from(relayManagedEndpointAllocations)
        .where(eq(relayManagedEndpointAllocations.tunnelName, tunnelName))
        .limit(1)
        .pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.mapError(
            (cause) =>
              new ManagedEndpointAllocationPersistenceError({
                operation: "get-by-tunnel-name",
                stage: "database-request",
                userId: "",
                environmentId: "",
                tunnelName,
                cause,
              }),
          ),
        );
    }),
    listByTunnelNames: Effect.fn("relay.managed_endpoint_allocations.list_by_tunnel_names")(
      function* (tunnelNames: ReadonlyArray<string>) {
        if (tunnelNames.length === 0) {
          return [];
        }
        const batches = Array.from(
          { length: Math.ceil(tunnelNames.length / MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE) },
          (_, index) =>
            tunnelNames.slice(
              index * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
              (index + 1) * MANAGED_ENDPOINT_ALLOCATION_LOOKUP_BATCH_SIZE,
            ),
        );
        const results = yield* Effect.forEach(
          batches,
          (batch) =>
            db
              .select({
                ...allocationSelection,
                recoveryEnabledAt: relayManagedEndpointAllocations.recoveryEnabledAt,
                recoveryEnvironmentPublicKey:
                  relayManagedEndpointAllocations.recoveryEnvironmentPublicKey,
                linkedEnvironmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
              })
              .from(relayManagedEndpointAllocations)
              .leftJoin(
                relayEnvironmentLinks,
                and(
                  eq(relayEnvironmentLinks.userId, relayManagedEndpointAllocations.userId),
                  eq(
                    relayEnvironmentLinks.environmentId,
                    relayManagedEndpointAllocations.environmentId,
                  ),
                  isNull(relayEnvironmentLinks.revokedAt),
                ),
              )
              .where(inArray(relayManagedEndpointAllocations.tunnelName, batch))
              .pipe(
                Effect.map((rows) =>
                  rows.map(
                    ({
                      recoveryEnabledAt,
                      recoveryEnvironmentPublicKey,
                      linkedEnvironmentPublicKey,
                      ...allocation
                    }) => ({
                      ...allocation,
                      recoveryEnabledAt,
                      recoveryEnvironmentPublicKey,
                      recoveryEnabled:
                        recoveryEnabledAt !== null &&
                        recoveryEnvironmentPublicKey !== null &&
                        recoveryEnvironmentPublicKey === linkedEnvironmentPublicKey,
                    }),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new ManagedEndpointAllocationPersistenceError({
                      operation: "list-tunnels",
                      stage: "database-request",
                      userId: "*",
                      environmentId: "*",
                      cause,
                    }),
                ),
              ),
          { concurrency: 1 },
        );
        return results.flat();
      },
    ),
  });
});

export const layer = Layer.effect(ManagedEndpointAllocations, make);
