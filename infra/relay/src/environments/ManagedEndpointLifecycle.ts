import { and, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations as table,
} from "../persistence/schema.ts";
import type { ManagedEndpointAllocation } from "./ManagedEndpointAllocations.ts";
import { allocationSelection } from "./managedEndpointAllocationSelection.ts";
import {
  MutationAction,
  MutationOutcome,
  Observation,
  PendingMutation,
  type AllocationKey,
  type Claim,
  type LifecycleState,
  type OperationKind,
  type ResourcePresence,
  type Target,
  type TransitionResult,
} from "./managedEndpointLifecycleContracts.ts";

export interface LifecycleAllocation extends ManagedEndpointAllocation {
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
}

export type AcquireResult =
  | { readonly status: "Acquired"; readonly claim: Claim; readonly allocation: LifecycleAllocation }
  | { readonly status: "Absent" | "Stale" | "Busy" | "RepairRequired" };
export type BeginResult =
  | { readonly status: "Applied"; readonly stepId: string }
  | { readonly status: "Cancelled" | "Stale" };

class LifecycleTransitionRejected extends Data.TaggedError("LifecycleTransitionRejected")<{
  readonly reason: "ambient-transaction" | "missing-step-uuid";
}> {}

export class LifecyclePersistenceError extends Schema.TaggedError<LifecyclePersistenceError>()(
  "ManagedEndpointLifecyclePersistenceError",
  {
    operation: Schema.Literals([
      "get",
      "acquire",
      "begin",
      "complete",
      "observe",
      "uncertain",
      "finish-idle",
      "finish-released",
      "remove",
      "cleanup-intent",
    ]),
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint lifecycle '${this.operation}' failed`;
  }
}

// No runtime layer consumes this service until the coordinated
// provider/publication conversion. There is deliberately no legacy classifier,
// owner reset, expiry, or standalone readiness/publication writer.
export class ManagedEndpointLifecycle extends Context.Service<
  ManagedEndpointLifecycle,
  {
    readonly get: (
      key: AllocationKey,
    ) => Effect.Effect<LifecycleAllocation | null, LifecyclePersistenceError>;
    readonly acquireOperation: (input: {
      readonly key: AllocationKey;
      readonly kind: OperationKind;
      readonly expectedTarget: Target;
    }) => Effect.Effect<AcquireResult, LifecyclePersistenceError>;
    /** Validates the action and mints a fresh step UUID in the intent transaction. */
    readonly beginMutation: (input: {
      readonly claim: Claim;
      readonly mutation: MutationAction;
    }) => Effect.Effect<BeginResult, LifecyclePersistenceError>;
    readonly completeMutation: (input: {
      readonly claim: Claim;
      readonly stepId: string;
      readonly outcome: MutationOutcome;
    }) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly recordObservation: (input: {
      readonly claim: Claim;
      readonly observation: Observation;
    }) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly retainUncertain: (
      claim: Claim,
    ) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly finishIdle: (
      claim: Claim,
    ) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly finishReleased: (input: {
      readonly claim: Claim;
      readonly markReleased?: boolean;
    }) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly removeClaimed: (
      claim: Claim,
    ) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    /** Unwired seam: runtime use requires integration into the revocation/publication transaction. */
    readonly requestCleanup: (
      target: Target,
    ) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
  }
>()("t3code-relay/environments/ManagedEndpointLifecycle") {}

const selection = {
  ...allocationSelection,
  allocationId: table.allocationId,
  lifecycleState: table.lifecycleState,
  operationId: table.operationId,
  operationKind: table.operationKind,
  operationStartedAt: table.operationStartedAt,
  pendingMutation: table.pendingMutation,
  cleanupRequested: table.cleanupRequested,
  tunnelPresence: table.tunnelPresence,
  dnsPresence: table.dnsPresence,
  dnsTargetTunnelId: table.dnsTargetTunnelId,
};
const applied: TransitionResult = { status: "Applied" };
const stale: TransitionResult = { status: "Stale" };
const whereKey = (key: AllocationKey) =>
  and(eq(table.userId, key.userId), eq(table.environmentId, key.environmentId));
const matchesTarget = (row: LifecycleAllocation, target: Target) =>
  row.userId === target.key.userId &&
  row.environmentId === target.key.environmentId &&
  row.allocationId === target.allocationId &&
  row.generation === target.generation &&
  row.tunnelId === target.tunnelId;
const matchesOwner = (row: LifecycleAllocation, claim: Claim) =>
  row.userId === claim.userId &&
  row.environmentId === claim.environmentId &&
  row.allocationId === claim.allocationId &&
  row.generation === claim.generation &&
  row.operationId === claim.operationId &&
  row.operationKind === claim.kind &&
  row.lifecycleState === "owned";
const absent = (presence: ResourcePresence) =>
  presence === "absent" || presence === "never_created";
const cancellable = (kind: OperationKind) => kind === "provision" || kind === "reconcile";
const decodeAction = Schema.decodeEffect(MutationAction);
const decodeOutcome = Schema.decodeEffect(MutationOutcome);
const decodeObservation = Schema.decodeEffect(Observation);
const decodePending = Schema.decodeEffect(PendingMutation);

const validAction = (row: LifecycleAllocation, action: MutationAction) => {
  switch (action.action) {
    case "create_tunnel":
      return (
        row.operationKind === "provision" &&
        row.tunnelName === action.tunnelName &&
        absent(row.tunnelPresence)
      );
    case "configure_tunnel":
      return (
        cancellable(row.operationKind ?? "release") &&
        row.tunnelPresence === "recorded" &&
        row.tunnelId === action.tunnelId &&
        row.tunnelName === action.tunnelName
      );
    case "delete_tunnel":
      return (
        (row.operationKind === "release" || row.operationKind === "deprovision") &&
        row.tunnelPresence === "recorded" &&
        row.tunnelId === action.tunnelId &&
        row.tunnelName === action.tunnelName
      );
    case "create_dns":
      return (
        row.operationKind === "provision" &&
        absent(row.dnsPresence) &&
        row.hostname === action.hostname &&
        row.tunnelPresence === "recorded" &&
        row.tunnelId === action.tunnelId
      );
    case "update_dns":
      return (
        row.operationKind === "provision" &&
        row.dnsPresence === "recorded" &&
        row.dnsRecordId === action.dnsRecordId &&
        row.hostname === action.hostname &&
        row.dnsTargetTunnelId === action.previousTunnelId &&
        row.tunnelPresence === "recorded" &&
        row.tunnelId === action.nextTunnelId
      );
    case "delete_dns":
      return (
        row.operationKind === "deprovision" &&
        row.dnsPresence === "recorded" &&
        row.dnsRecordId === action.dnsRecordId &&
        row.hostname === action.hostname &&
        row.dnsTargetTunnelId === action.previousTunnelId
      );
  }
};

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const persist = <A, E, R>(
    operation: LifecyclePersistenceError["operation"],
    key: AllocationKey,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.mapError((cause) => new LifecyclePersistenceError({ operation, ...key, cause })),
      Effect.catchDefect((cause) =>
        Effect.fail(new LifecyclePersistenceError({ operation, ...key, cause })),
      ),
    );
  const transaction = <A, E, R>(
    operation: LifecyclePersistenceError["operation"],
    key: AllocationKey,
    effect: Effect.Effect<A, E, R>,
  ) =>
    persist(
      operation,
      key,
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(db.$client.transactionService))) {
          return yield* new LifecycleTransitionRejected({ reason: "ambient-transaction" });
        }
        return yield* db.$client.withTransaction(
          Effect.gen(function* () {
            yield* db.$client`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
            yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay-managed-tunnel:${key.userId}`}, 0))`;
            return yield* effect;
          }),
        );
      }),
    );
  const load = (key: AllocationKey) =>
    db
      .select(selection)
      .from(table)
      .where(whereKey(key))
      .limit(1)
      .for("update")
      .pipe(Effect.map((rows) => rows[0] ?? null));
  const lockLink = (key: AllocationKey) =>
    db
      .select({
        providerKind: relayEnvironmentLinks.endpointProviderKind,
        revokedAt: relayEnvironmentLinks.revokedAt,
      })
      .from(relayEnvironmentLinks)
      .where(
        and(
          eq(relayEnvironmentLinks.userId, key.userId),
          eq(relayEnvironmentLinks.environmentId, key.environmentId),
        ),
      )
      .limit(1)
      .for("update")
      .pipe(Effect.map((rows) => rows[0] ?? null));
  const ownerWhere = (claim: Claim) =>
    and(
      whereKey(claim),
      eq(table.allocationId, claim.allocationId),
      eq(table.generation, claim.generation),
      eq(table.operationId, claim.operationId),
      eq(table.operationKind, claim.kind),
      eq(table.lifecycleState, "owned"),
    );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const clearOwner = {
    lifecycleState: "idle" as const,
    operationId: null,
    operationKind: null,
    operationStartedAt: null,
    pendingMutation: null,
    generation: sql`${table.generation} + 1`,
  };
  const settle = (
    operation: "finish-idle" | "finish-released",
    claim: Claim,
    markReleased = false,
  ) =>
    transaction(
      operation,
      claim,
      Effect.gen(function* () {
        const row = yield* load(claim);
        if (!row || !matchesOwner(row, claim) || row.pendingMutation !== null) return stale;
        if (
          operation === "finish-released" &&
          (claim.kind !== "release" || !absent(row.tunnelPresence))
        )
          return stale;
        const timestamp = yield* now;
        // Never-created resources may finish safely, but cannot invent a
        // history marker for a previously recorded tunnel's confirmed absence.
        const markConfirmedTunnelReleased =
          markReleased && row.tunnelPresence === "absent" && row.tunnelId !== null;
        yield* db
          .update(table)
          .set({
            ...clearOwner,
            updatedAt: timestamp,
            ...(markConfirmedTunnelReleased ? { tunnelReleasedAt: timestamp } : {}),
          })
          .where(ownerWhere(claim));
        return applied;
      }),
    );

  return ManagedEndpointLifecycle.of({
    get: (key) =>
      persist(
        "get",
        key,
        db
          .select(selection)
          .from(table)
          .where(whereKey(key))
          .limit(1)
          .pipe(Effect.map((rows) => rows[0] ?? null)),
      ),
    acquireOperation: (input) =>
      transaction(
        "acquire",
        input.key,
        Effect.gen(function* () {
          const link = input.kind === "deprovision" ? yield* lockLink(input.key) : null;
          const row = yield* load(input.key);
          if (!row) return { status: "Absent" as const };
          if (!matchesTarget(row, input.expectedTarget)) return { status: "Stale" as const };
          if (row.lifecycleState === "legacy_unverified" || row.lifecycleState === "uncertain")
            return { status: "RepairRequired" as const };
          if (row.lifecycleState !== "idle" || row.pendingMutation !== null)
            return { status: "Busy" as const };
          if (
            (row.cleanupRequested && cancellable(input.kind)) ||
            (link?.providerKind === "cloudflare_tunnel" && link.revokedAt === null)
          )
            return { status: "Busy" as const };
          const rows = yield* db
            .update(table)
            .set({
              lifecycleState: "owned",
              operationId: sql`gen_random_uuid()`,
              operationKind: input.kind,
              operationStartedAt: yield* now,
              generation: sql`${table.generation} + 1`,
            })
            .where(
              and(
                whereKey(input.key),
                eq(table.allocationId, row.allocationId),
                eq(table.generation, row.generation),
                eq(table.lifecycleState, "idle"),
              ),
            )
            .returning(selection);
          const allocation = rows[0];
          if (!allocation?.operationId) return { status: "Stale" as const };
          return {
            status: "Acquired" as const,
            allocation,
            claim: {
              ...input.key,
              allocationId: allocation.allocationId,
              operationId: allocation.operationId,
              generation: allocation.generation,
              kind: input.kind,
            },
          };
        }),
      ),
    beginMutation: (input) =>
      transaction(
        "begin",
        input.claim,
        Effect.gen(function* () {
          const action = yield* decodeAction(input.mutation, {
            onExcessProperty: "error",
          });
          const row = yield* load(input.claim);
          if (!row || !matchesOwner(row, input.claim) || row.pendingMutation !== null)
            return { status: "Stale" as const };
          if (row.cleanupRequested && cancellable(input.claim.kind))
            return { status: "Cancelled" as const };
          if (!validAction(row, action)) return { status: "Stale" as const };
          const ids = yield* db.$client<{
            step_id: string;
          }>`SELECT gen_random_uuid()::text AS step_id`;
          const stepId = ids[0]?.step_id;
          if (!stepId)
            return yield* new LifecycleTransitionRejected({ reason: "missing-step-uuid" });
          const pendingMutation = { ...action, stepId } satisfies PendingMutation;
          yield* db
            .update(table)
            .set({ pendingMutation, updatedAt: yield* now })
            .where(ownerWhere(input.claim));
          return { status: "Applied" as const, stepId };
        }),
      ),
    completeMutation: (input) =>
      transaction(
        "complete",
        input.claim,
        Effect.gen(function* () {
          const outcome = yield* decodeOutcome(input.outcome, {
            onExcessProperty: "error",
          });
          const row = yield* load(input.claim);
          if (
            !row ||
            !matchesOwner(row, input.claim) ||
            row.pendingMutation?.stepId !== input.stepId
          )
            return stale;
          const pending = yield* decodePending(row.pendingMutation, { onExcessProperty: "error" });
          if (outcome.action !== "rejected_no_effect" && outcome.action !== pending.action)
            return stale;
          const patch: Partial<typeof table.$inferInsert> = {};
          switch (outcome.action) {
            case "create_tunnel":
              if (pending.action !== "create_tunnel" || outcome.tunnelName !== pending.tunnelName)
                return stale;
              Object.assign(patch, {
                tunnelId: outcome.tunnelId,
                tunnelPresence: "recorded",
                tunnelReleasedAt: null,
              });
              if (row.tunnelId !== outcome.tunnelId)
                Object.assign(patch, {
                  readyAt: null,
                  origin: null,
                  recoveryEnabledAt: null,
                  recoveryEnvironmentPublicKey: null,
                });
              break;
            case "configure_tunnel":
              if (pending.action !== "configure_tunnel" || outcome.tunnelId !== pending.tunnelId)
                return stale;
              break;
            case "delete_tunnel":
              if (pending.action !== "delete_tunnel" || outcome.tunnelId !== pending.tunnelId)
                return stale;
              patch.tunnelPresence = "absent";
              break;
            case "create_dns":
            case "update_dns": {
              const target =
                pending.action === "create_dns"
                  ? pending.tunnelId
                  : pending.action === "update_dns"
                    ? pending.nextTunnelId
                    : null;
              if (
                (pending.action !== "create_dns" && pending.action !== "update_dns") ||
                outcome.hostname !== pending.hostname ||
                outcome.tunnelId !== target ||
                (pending.action === "update_dns" && outcome.dnsRecordId !== pending.dnsRecordId)
              )
                return stale;
              Object.assign(patch, {
                dnsRecordId: outcome.dnsRecordId,
                dnsTargetTunnelId: outcome.tunnelId,
                dnsPresence: "recorded",
              });
              break;
            }
            case "delete_dns":
              if (pending.action !== "delete_dns" || outcome.dnsRecordId !== pending.dnsRecordId)
                return stale;
              patch.dnsPresence = "absent";
              break;
            case "rejected_no_effect":
              break;
          }
          yield* db
            .update(table)
            .set({ ...patch, pendingMutation: null, updatedAt: yield* now })
            .where(
              and(
                ownerWhere(input.claim),
                sql`${table.pendingMutation}->>'stepId' = ${input.stepId}`,
              ),
            );
          return applied;
        }),
      ),
    recordObservation: (input) =>
      transaction(
        "observe",
        input.claim,
        Effect.gen(function* () {
          const observation = yield* decodeObservation(input.observation, {
            onExcessProperty: "error",
          });
          const row = yield* load(input.claim);
          if (!row || !matchesOwner(row, input.claim) || row.pendingMutation !== null) return stale;
          const patch: Partial<typeof table.$inferInsert> = {};
          if (observation.resource === "tunnel") {
            if (observation.presence === "recorded") {
              if (
                observation.tunnelName !== row.tunnelName ||
                (row.tunnelPresence === "recorded" && row.tunnelId !== observation.tunnelId) ||
                (input.claim.kind !== "provision" &&
                  row.tunnelId !== null &&
                  row.tunnelId !== observation.tunnelId)
              )
                return stale;
              Object.assign(patch, {
                tunnelId: observation.tunnelId,
                tunnelPresence: "recorded",
                tunnelReleasedAt: null,
              });
              if (row.tunnelId !== observation.tunnelId)
                Object.assign(patch, {
                  readyAt: null,
                  origin: null,
                  recoveryEnabledAt: null,
                  recoveryEnvironmentPublicKey: null,
                });
            } else if (observation.presence === "absent") {
              if (row.tunnelId !== observation.tunnelId) return stale;
              patch.tunnelPresence = "absent";
            } else {
              if (row.tunnelId !== null || row.tunnelPresence !== "unresolved") return stale;
              patch.tunnelPresence = "never_created";
            }
          } else if (observation.presence === "recorded") {
            if (
              observation.hostname !== row.hostname ||
              (row.dnsPresence === "recorded" && row.dnsRecordId !== observation.dnsRecordId) ||
              (input.claim.kind !== "provision" &&
                row.dnsRecordId !== null &&
                row.dnsRecordId !== observation.dnsRecordId) ||
              (observation.tunnelId !== row.tunnelId &&
                observation.tunnelId !== row.dnsTargetTunnelId)
            )
              return stale;
            Object.assign(patch, {
              dnsRecordId: observation.dnsRecordId,
              dnsPresence: "recorded",
              dnsTargetTunnelId: observation.tunnelId,
            });
          } else if (observation.presence === "absent") {
            if (row.dnsRecordId !== observation.dnsRecordId) return stale;
            patch.dnsPresence = "absent";
          } else {
            if (row.dnsRecordId !== null || row.dnsPresence !== "unresolved") return stale;
            patch.dnsPresence = "never_created";
          }
          yield* db
            .update(table)
            .set({ ...patch, updatedAt: yield* now })
            .where(ownerWhere(input.claim));
          return applied;
        }),
      ),
    retainUncertain: (claim) =>
      transaction(
        "uncertain",
        claim,
        Effect.gen(function* () {
          const row = yield* load(claim);
          if (
            !row ||
            (!matchesOwner(row, claim) &&
              !(
                row.lifecycleState === "uncertain" &&
                row.allocationId === claim.allocationId &&
                row.operationId === claim.operationId &&
                row.operationKind === claim.kind &&
                row.generation === claim.generation
              ))
          )
            return stale;
          yield* db
            .update(table)
            .set({ lifecycleState: "uncertain", updatedAt: yield* now })
            .where(
              and(
                whereKey(claim),
                eq(table.allocationId, claim.allocationId),
                eq(table.generation, claim.generation),
                eq(table.operationId, claim.operationId),
                eq(table.operationKind, claim.kind),
              ),
            );
          return applied;
        }),
      ),
    finishIdle: (claim) => settle("finish-idle", claim),
    finishReleased: ({ claim, markReleased }) => settle("finish-released", claim, markReleased),
    removeClaimed: (claim) =>
      transaction(
        "remove",
        claim,
        Effect.gen(function* () {
          const link = yield* lockLink(claim);
          const row = yield* load(claim);
          if (
            !row ||
            claim.kind !== "deprovision" ||
            !matchesOwner(row, claim) ||
            row.pendingMutation !== null ||
            !row.cleanupRequested ||
            !absent(row.tunnelPresence) ||
            !absent(row.dnsPresence) ||
            (link?.providerKind === "cloudflare_tunnel" && link.revokedAt === null)
          )
            return stale;
          yield* db.delete(table).where(ownerWhere(claim));
          return applied;
        }),
      ),
    requestCleanup: (target) =>
      transaction(
        "cleanup-intent",
        target.key,
        Effect.gen(function* () {
          yield* lockLink(target.key);
          const row = yield* load(target.key);
          if (!row || !matchesTarget(row, target)) return stale;
          yield* db
            .update(table)
            .set({ cleanupRequested: true, updatedAt: yield* now })
            .where(
              and(
                whereKey(target.key),
                eq(table.allocationId, target.allocationId),
                eq(table.generation, target.generation),
              ),
            );
          return applied;
        }),
      ),
  });
});

export const layer = Layer.effect(ManagedEndpointLifecycle, make);
