import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

export type LifecycleState = "idle" | "owned" | "uncertain" | "legacy_unverified";
export type OperationKind = "provision" | "release" | "deprovision" | "reconcile";
export type ResourcePresence = "unresolved" | "never_created" | "recorded" | "absent";

export interface AllocationKey {
  readonly userId: string;
  readonly environmentId: string;
}

export interface Claim extends AllocationKey {
  readonly allocationId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly kind: OperationKind;
}

export interface Target {
  readonly key: AllocationKey;
  readonly allocationId: string;
  readonly generation: number;
  readonly tunnelId: string | null;
}

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(191));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253));
const Origin = Schema.Struct({
  localHttpHost: Schema.Literals(["localhost", "127.0.0.1", "::1", "[::1]"]),
  localHttpPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});
const Actions = [
  Schema.Struct({ action: Schema.Literal("create_tunnel"), tunnelName: Name }),
  Schema.Struct({
    action: Schema.Literal("configure_tunnel"),
    tunnelId: ResourceId,
    tunnelName: Name,
    origin: Origin,
  }),
  Schema.Struct({
    action: Schema.Literal("delete_tunnel"),
    tunnelId: ResourceId,
    tunnelName: Name,
  }),
  Schema.Struct({ action: Schema.Literal("create_dns"), hostname: Name, tunnelId: ResourceId }),
  Schema.Struct({
    action: Schema.Literal("update_dns"),
    dnsRecordId: ResourceId,
    hostname: Name,
    previousTunnelId: ResourceId,
    nextTunnelId: ResourceId,
  }),
  Schema.Struct({
    action: Schema.Literal("delete_dns"),
    dnsRecordId: ResourceId,
    hostname: Name,
    previousTunnelId: ResourceId,
  }),
] as const;

export const MutationAction = Schema.Union(Actions);
export type MutationAction = typeof MutationAction.Type;
const StepId = Schema.String.check(Schema.isUUID());
export const PendingMutation = Schema.Union([
  Schema.Struct({ ...Actions[0].fields, stepId: StepId }),
  Schema.Struct({ ...Actions[1].fields, stepId: StepId }),
  Schema.Struct({ ...Actions[2].fields, stepId: StepId }),
  Schema.Struct({ ...Actions[3].fields, stepId: StepId }),
  Schema.Struct({ ...Actions[4].fields, stepId: StepId }),
  Schema.Struct({ ...Actions[5].fields, stepId: StepId }),
]);
export type PendingMutation = typeof PendingMutation.Type;

export const MutationOutcome = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create_tunnel"),
    tunnelId: ResourceId,
    tunnelName: Name,
  }),
  Schema.Struct({ action: Schema.Literal("configure_tunnel"), tunnelId: ResourceId }),
  Schema.Struct({ action: Schema.Literal("delete_tunnel"), tunnelId: ResourceId }),
  Schema.Struct({
    action: Schema.Literal("create_dns"),
    dnsRecordId: ResourceId,
    hostname: Name,
    tunnelId: ResourceId,
  }),
  Schema.Struct({
    action: Schema.Literal("update_dns"),
    dnsRecordId: ResourceId,
    hostname: Name,
    tunnelId: ResourceId,
  }),
  Schema.Struct({ action: Schema.Literal("delete_dns"), dnsRecordId: ResourceId }),
  // The caller must first inspect a validated single-attempt no-effect response.
  Schema.Struct({ action: Schema.Literal("rejected_no_effect") }),
]);
export type MutationOutcome = typeof MutationOutcome.Type;

export const Observation = Schema.Union([
  Schema.Struct({
    resource: Schema.Literal("tunnel"),
    presence: Schema.Literal("recorded"),
    tunnelId: ResourceId,
    tunnelName: Name,
  }),
  Schema.Struct({
    resource: Schema.Literal("tunnel"),
    presence: Schema.Literal("absent"),
    tunnelId: ResourceId,
  }),
  Schema.Struct({ resource: Schema.Literal("tunnel"), presence: Schema.Literal("never_created") }),
  Schema.Struct({
    resource: Schema.Literal("dns"),
    presence: Schema.Literal("recorded"),
    dnsRecordId: ResourceId,
    hostname: Name,
    tunnelId: ResourceId,
  }),
  Schema.Struct({
    resource: Schema.Literal("dns"),
    presence: Schema.Literal("absent"),
    dnsRecordId: ResourceId,
  }),
  Schema.Struct({ resource: Schema.Literal("dns"), presence: Schema.Literal("never_created") }),
]);
export type Observation = typeof Observation.Type;

export type TransitionResult = { readonly status: "Applied" } | { readonly status: "Stale" };

export const targetFor = (
  allocation: AllocationKey & {
    readonly allocationId: string;
    readonly generation: number;
    readonly tunnelId: string | null;
  },
): Target => ({
  key: { userId: allocation.userId, environmentId: allocation.environmentId },
  allocationId: allocation.allocationId,
  generation: allocation.generation,
  tunnelId: allocation.tunnelId,
});

/** Authority captured by the caller, revalidated in both owner and completion transactions. */
export interface ExpectedManagedLink {
  readonly environmentPublicKey: string;
  readonly expectedLinkIncarnationId: string;
  readonly endpoint: RelayManagedEndpoint;
}

export type ProvisionPublication =
  | {
      readonly kind: "link";
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
    }
  | ({ readonly kind: "recover" } & ExpectedManagedLink);

/** B2b2 provider entry points must require this purpose; the optional B1 seam is SQL-test-only. */
export type AcquisitionPurpose =
  | { readonly kind: "link" }
  | ({ readonly kind: "recover" | "reconcile" } & ExpectedManagedLink);

export type ProvisionPublicationResult =
  | {
      readonly status: "Applied";
      readonly kind: "link";
      readonly endpoint: RelayManagedEndpoint;
      readonly environmentCredential: string;
    }
  | {
      readonly status: "Applied";
      readonly kind: "recover";
      readonly endpoint: RelayManagedEndpoint;
    }
  | { readonly status: "Stale" };

export interface CapturedCleanup {
  readonly target: Target | null;
  readonly tunnelName: string | null;
}
