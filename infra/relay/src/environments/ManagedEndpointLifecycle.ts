import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
} from "@t3tools/contracts/relay";
import { and, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { transactionActive } from "../runtimePostgres.ts";
import {
  relayEnvironmentLinks,
  relayManagedEndpointAllocations as table,
} from "../persistence/schema.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import { managedEndpointForHostname } from "../deploymentConfig.ts";
import { acquireEnvironmentLinkWriteLocks } from "./environmentLinkWriteLocks.ts";
import type { ManagedEndpointAllocation } from "./ManagedEndpointAllocations.ts";
import { allocationSelection } from "./managedEndpointAllocationSelection.ts";
import {
  MutationAction,
  MutationOutcome,
  Observation,
  PendingMutation,
  targetFor,
  type AcquisitionPurpose,
  type ExpectedManagedLink,
  type ProvisionPublication,
  type ProvisionPublicationResult,
  type CapturedCleanup,
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
  readonly reason:
    | "ambient-transaction"
    | "missing-step-uuid"
    | "invalid-publication"
    | "owner-update-lost"
    | "cleanup-update-lost";
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
      "publish-provision",
      "complete-reconcile",
      "revoke-cleanup",
      "publish-without-tunnel",
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

// Runtime provider calls use short committed lifecycle transactions. There is deliberately no legacy classifier,
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
      readonly purpose?: AcquisitionPurpose;
    }) => Effect.Effect<AcquireResult, LifecyclePersistenceError>;
    readonly publishProvision: (input: {
      readonly claim: Claim;
      readonly origin: RelayManagedEndpointOrigin;
      readonly publication: ProvisionPublication;
    }) => Effect.Effect<ProvisionPublicationResult, LifecyclePersistenceError>;
    readonly completeReconcile: (input: {
      readonly claim: Claim;
      readonly origin: RelayManagedEndpointOrigin;
      readonly expectedLink: ExpectedManagedLink;
    }) => Effect.Effect<TransitionResult, LifecyclePersistenceError>;
    readonly revokeAndRequestCleanup: (
      key: AllocationKey,
    ) => Effect.Effect<CapturedCleanup & { readonly revoked: boolean }, LifecyclePersistenceError>;
    readonly publishWithoutTunnel: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly verifiedProof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<
      CapturedCleanup & { readonly environmentCredential: string },
      LifecyclePersistenceError
    >;
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
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
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
        if (yield* transactionActive(db)) {
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
        environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
        incarnationId: relayEnvironmentLinks.incarnationId,
        managedTunnelsEnabled: relayEnvironmentLinks.managedTunnelsEnabled,
        httpBaseUrl: relayEnvironmentLinks.endpointHttpBaseUrl,
        wsBaseUrl: relayEnvironmentLinks.endpointWsBaseUrl,
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
  // Called only after the user lock, before either row lock. Every coordinated
  // ordinary writer must use this order; provider effects run after commit.
  const lockPublicationLink = (key: AllocationKey, requestedKey?: string) =>
    Effect.gen(function* () {
      const old = yield* db
        .select({ environmentPublicKey: relayEnvironmentLinks.environmentPublicKey })
        .from(relayEnvironmentLinks)
        .where(
          and(
            eq(relayEnvironmentLinks.userId, key.userId),
            eq(relayEnvironmentLinks.environmentId, key.environmentId),
          ),
        )
        .limit(1);
      yield* acquireEnvironmentLinkWriteLocks(db, key.environmentId, [
        ...(old[0] ? [old[0].environmentPublicKey] : []),
        ...(requestedKey === undefined ? [] : [requestedKey]),
      ]);
      return yield* lockLink(key);
    });
  const sameEndpoint = (a: RelayManagedEndpoint, b: RelayManagedEndpoint) =>
    a.providerKind === b.providerKind &&
    a.httpBaseUrl === b.httpBaseUrl &&
    a.wsBaseUrl === b.wsBaseUrl;
  const currentAuthority = (
    link: Effect.Success<ReturnType<typeof lockLink>>,
    row: LifecycleAllocation,
    expected: ExpectedManagedLink,
  ) =>
    link !== null &&
    link.revokedAt === null &&
    link.managedTunnelsEnabled &&
    link.providerKind === "cloudflare_tunnel" &&
    link.environmentPublicKey === expected.environmentPublicKey &&
    link.incarnationId === expected.expectedLinkIncarnationId &&
    sameEndpoint(
      {
        providerKind: "cloudflare_tunnel",
        httpBaseUrl: link.httpBaseUrl,
        wsBaseUrl: link.wsBaseUrl,
      },
      expected.endpoint,
    ) &&
    sameEndpoint(expected.endpoint, managedEndpointForHostname(row.hostname));
  const consistentProof = (
    key: AllocationKey,
    request: RelayEnvironmentLinkRequest,
    proof: RelayEnvironmentLinkProofPayload,
  ) =>
    proof.environmentId === key.environmentId &&
    proof.sub === key.environmentId &&
    proof.descriptor.environmentId === key.environmentId &&
    proof.environmentPublicKey.length > 0 &&
    (!request.managedTunnelsEnabled || proof.scopes.includes("managed_tunnels")) &&
    (!(request.notificationsEnabled || request.liveActivitiesEnabled) ||
      proof.scopes.includes("agent_activity_notifications"));
  const configuredOrigin = (row: LifecycleAllocation, origin: RelayManagedEndpointOrigin) =>
    row.origin !== null &&
    row.origin.localHttpHost === origin.localHttpHost &&
    row.origin.localHttpPort === origin.localHttpPort;
  const recordedReady = (row: LifecycleAllocation, claim: Claim) =>
    matchesOwner(row, claim) &&
    row.pendingMutation === null &&
    !row.cleanupRequested &&
    row.tunnelPresence === "recorded" &&
    row.tunnelId !== null &&
    row.dnsPresence === "recorded" &&
    row.dnsRecordId !== null &&
    row.dnsTargetTunnelId === row.tunnelId;
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
        const updated = yield* db
          .update(table)
          .set({
            ...clearOwner,
            updatedAt: timestamp,
            ...(markConfirmedTunnelReleased ? { tunnelReleasedAt: timestamp } : {}),
          })
          .where(ownerWhere(claim))
          .returning({ allocationId: table.allocationId });
        return updated.length === 1 ? applied : stale;
      }),
    );

  const completeReady = (
    claim: Claim,
    origin: RelayManagedEndpointOrigin,
    publicKey: string,
    enableRecovery: boolean,
  ) =>
    Effect.gen(function* () {
      const timestamp = yield* now;
      const updated = yield* db
        .update(table)
        .set({
          ...clearOwner,
          readyAt: timestamp,
          origin,
          recoveryEnabledAt: enableRecovery
            ? timestamp
            : sql`CASE WHEN ${table.recoveryEnvironmentPublicKey} = ${publicKey} THEN ${table.recoveryEnabledAt} ELSE NULL END`,
          recoveryEnvironmentPublicKey: enableRecovery
            ? publicKey
            : sql`CASE WHEN ${table.recoveryEnvironmentPublicKey} = ${publicKey} THEN ${table.recoveryEnvironmentPublicKey} ELSE NULL END`,
          tunnelReleasedAt: null,
          updatedAt: timestamp,
        })
        .where(ownerWhere(claim))
        .returning({ allocationId: table.allocationId });
      // Fail the transaction so earlier authority/credential writes cannot commit.
      if (updated.length !== 1)
        return yield* new LifecycleTransitionRejected({ reason: "owner-update-lost" });
    });
  const cleanupCaptured = (row: LifecycleAllocation | null) =>
    Effect.gen(function* () {
      if (!row) return { target: null, tunnelName: null } satisfies CapturedCleanup;
      const updated = yield* db
        .update(table)
        .set({ cleanupRequested: true, updatedAt: yield* now })
        .where(
          and(
            whereKey(row),
            eq(table.allocationId, row.allocationId),
            eq(table.generation, row.generation),
          ),
        )
        .returning({ allocationId: table.allocationId });
      if (updated.length !== 1)
        return yield* new LifecycleTransitionRejected({ reason: "cleanup-update-lost" });
      return { target: targetFor(row), tunnelName: row.tunnelName } satisfies CapturedCleanup;
    });
  const publishLink = (
    key: AllocationKey,
    request: RelayEnvironmentLinkRequest,
    proof: RelayEnvironmentLinkProofPayload,
    endpoint: RelayManagedEndpoint,
    oldKey: string | undefined,
  ) =>
    Effect.gen(function* () {
      yield* links.upsert({ userId: key.userId, request, proof, endpoint });
      if (oldKey !== undefined && oldKey !== proof.environmentPublicKey) {
        yield* credentials.revokeForEnvironmentPublicKey({
          environmentId: key.environmentId,
          environmentPublicKey: oldKey,
        });
      }
      return yield* credentials.create({
        environmentId: key.environmentId,
        environmentPublicKey: proof.environmentPublicKey,
      });
    });

  return ManagedEndpointLifecycle.of({
    get: (key) =>
      persist(
        "get",
        key,
        Effect.gen(function* () {
          if (yield* transactionActive(db))
            return yield* new LifecycleTransitionRejected({ reason: "ambient-transaction" });
          const rows = yield* db.select(selection).from(table).where(whereKey(key)).limit(1);
          return rows[0] ?? null;
        }),
      ),
    acquireOperation: (input) =>
      transaction(
        "acquire",
        input.key,
        Effect.gen(function* () {
          const purpose = input.purpose;
          const link = purpose
            ? yield* lockPublicationLink(
                input.key,
                purpose.kind === "link" ? undefined : purpose.environmentPublicKey,
              )
            : input.kind === "deprovision"
              ? yield* lockLink(input.key)
              : null;
          const row = yield* load(input.key);
          if (!row) return { status: "Absent" as const };
          if (!matchesTarget(row, input.expectedTarget)) return { status: "Stale" as const };
          if (
            purpose &&
            ((purpose.kind === "link" && input.kind !== "provision") ||
              (purpose.kind === "recover" && input.kind !== "provision") ||
              (purpose.kind === "reconcile" && input.kind !== "reconcile") ||
              (purpose.kind !== "link" && !currentAuthority(link, row, purpose)))
          )
            return { status: "Stale" as const };
          if (row.lifecycleState === "legacy_unverified" || row.lifecycleState === "uncertain")
            return { status: "RepairRequired" as const };
          if (row.lifecycleState !== "idle" || row.pendingMutation !== null)
            return { status: "Busy" as const };
          if (
            (row.cleanupRequested && cancellable(input.kind)) ||
            (input.kind === "deprovision" &&
              link?.providerKind === "cloudflare_tunnel" &&
              link.managedTunnelsEnabled &&
              link.revokedAt === null)
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
    publishProvision: ({ claim, origin, publication }) =>
      transaction(
        "publish-provision",
        claim,
        Effect.gen(function* () {
          const publicKey =
            publication.kind === "link"
              ? publication.proof.environmentPublicKey
              : publication.environmentPublicKey;
          const link = yield* lockPublicationLink(claim, publicKey);
          const row = yield* load(claim);
          if (
            !row ||
            claim.kind !== "provision" ||
            !recordedReady(row, claim) ||
            !configuredOrigin(row, origin)
          )
            return stale;
          const endpoint = managedEndpointForHostname(row.hostname);
          if (publication.kind === "recover") {
            if (!currentAuthority(link, row, publication)) return stale;
            yield* completeReady(claim, origin, publicKey, true);
            return { status: "Applied" as const, kind: "recover" as const, endpoint };
          }
          if (
            !publication.request.managedTunnelsEnabled ||
            !consistentProof(claim, publication.request, publication.proof) ||
            origin.localHttpHost !== publication.proof.origin.localHttpHost ||
            origin.localHttpPort !== publication.proof.origin.localHttpPort
          )
            return yield* new LifecycleTransitionRejected({ reason: "invalid-publication" });
          const environmentCredential = yield* publishLink(
            claim,
            publication.request,
            publication.proof,
            endpoint,
            link?.environmentPublicKey,
          );
          yield* completeReady(claim, origin, publicKey, false);
          return {
            status: "Applied" as const,
            kind: "link" as const,
            endpoint,
            environmentCredential,
          };
        }),
      ),
    completeReconcile: ({ claim, origin, expectedLink }) =>
      transaction(
        "complete-reconcile",
        claim,
        Effect.gen(function* () {
          const link = yield* lockPublicationLink(claim, expectedLink.environmentPublicKey);
          const row = yield* load(claim);
          if (
            !row ||
            claim.kind !== "reconcile" ||
            !recordedReady(row, claim) ||
            !configuredOrigin(row, origin) ||
            !currentAuthority(link, row, expectedLink)
          )
            return stale;
          yield* completeReady(claim, origin, expectedLink.environmentPublicKey, true);
          return applied;
        }),
      ),
    revokeAndRequestCleanup: (key) =>
      transaction(
        "revoke-cleanup",
        key,
        Effect.gen(function* () {
          const link = yield* lockPublicationLink(key);
          const row = yield* load(key);
          const revoked = link?.revokedAt === null ? yield* links.revokeForUser(key) : false;
          // Persisted authority, including revoked retries, determines the key.
          if (link)
            yield* credentials.revokeForEnvironmentPublicKey({
              environmentId: key.environmentId,
              environmentPublicKey: link.environmentPublicKey,
            });
          return { revoked, ...(yield* cleanupCaptured(row)) };
        }),
      ),
    publishWithoutTunnel: ({ userId, request, verifiedProof, endpoint }) => {
      const key = { userId, environmentId: verifiedProof.environmentId };
      return transaction(
        "publish-without-tunnel",
        key,
        Effect.gen(function* () {
          if (request.managedTunnelsEnabled || !consistentProof(key, request, verifiedProof))
            return yield* new LifecycleTransitionRejected({ reason: "invalid-publication" });
          const link = yield* lockPublicationLink(key, verifiedProof.environmentPublicKey);
          const row = yield* load(key);
          const environmentCredential = yield* publishLink(
            key,
            request,
            verifiedProof,
            endpoint,
            link?.environmentPublicKey,
          );
          return { environmentCredential, ...(yield* cleanupCaptured(row)) };
        }),
      );
    },
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
          const updated = yield* db
            .update(table)
            .set({ pendingMutation, updatedAt: yield* now })
            .where(ownerWhere(input.claim))
            .returning({ allocationId: table.allocationId });
          return updated.length === 1
            ? { status: "Applied" as const, stepId }
            : { status: "Stale" as const };
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
              patch.origin = pending.origin;
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
          const updated = yield* db
            .update(table)
            .set({ ...patch, pendingMutation: null, updatedAt: yield* now })
            .where(
              and(
                ownerWhere(input.claim),
                sql`${table.pendingMutation}->>'stepId' = ${input.stepId}`,
              ),
            )
            .returning({ allocationId: table.allocationId });
          return updated.length === 1 ? applied : stale;
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
          const updated = yield* db
            .update(table)
            .set({ ...patch, updatedAt: yield* now })
            .where(ownerWhere(input.claim))
            .returning({ allocationId: table.allocationId });
          return updated.length === 1 ? applied : stale;
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
          const updated = yield* db
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
            )
            .returning({ allocationId: table.allocationId });
          return updated.length === 1 ? applied : stale;
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
            (link?.providerKind === "cloudflare_tunnel" &&
              link.managedTunnelsEnabled &&
              link.revokedAt === null)
          )
            return stale;
          const removed = yield* db
            .delete(table)
            .where(ownerWhere(claim))
            .returning({ allocationId: table.allocationId });
          return removed.length === 1 ? applied : stale;
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
          const updated = yield* db
            .update(table)
            .set({ cleanupRequested: true, updatedAt: yield* now })
            .where(
              and(
                whereKey(target.key),
                eq(table.allocationId, target.allocationId),
                eq(table.generation, target.generation),
              ),
            )
            .returning({ allocationId: table.allocationId });
          return updated.length === 1 ? applied : stale;
        }),
      ),
  });
});

export const layer = Layer.effect(ManagedEndpointLifecycle, make);
