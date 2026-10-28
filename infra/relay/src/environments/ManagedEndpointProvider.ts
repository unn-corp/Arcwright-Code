import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as CloudflareRetry from "@distilled.cloud/cloudflare/Retry";
import * as Clock from "effect/Clock";
import * as CloudflareApiPause from "./CloudflareApiPause.ts";
import type { ResultInfo } from "@distilled.cloud/cloudflare/Pagination";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { TunnelNotFound, DuplicateTunnelName } from "@distilled.cloud/cloudflare/zero-trust";
import { RecordNotFound, DnsRecordAlreadyExists } from "@distilled.cloud/cloudflare/dns";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";

import * as RelayConfiguration from "../Config.ts";
import {
  managedEndpointDigestInput,
  managedEndpointHostname,
  managedEndpointTunnelName,
} from "../deploymentConfig.ts";
import * as RelayDb from "../db.ts";
import { transactionActive } from "../runtimePostgres.ts";
import * as ManagedEndpointLifecycle from "./ManagedEndpointLifecycle.ts";
import {
  targetFor,
  type AllocationKey,
  type Claim,
  type Target,
  type AcquisitionPurpose,
  type ExpectedManagedLink,
  type ProvisionPublication,
  type OperationKind,
  type ResourcePresence,
  type TransitionResult,
  type Observation,
  type MutationAction,
  type MutationOutcome,
} from "./managedEndpointLifecycleContracts.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";

export class ManagedEndpointProvisioningNotConfigured extends Schema.TaggedError<ManagedEndpointProvisioningNotConfigured>()(
  "ManagedEndpointProvisioningNotConfigured",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    missingSettings: Schema.Array(
      Schema.Literals(["managedEndpointBaseDomain", "managedEndpointNamespace"]),
    ),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning is not configured for user '${this.userId}', environment '${this.environmentId}': missing ${this.missingSettings.join(", ")}`;
  }
}

const ManagedEndpointProvisioningStage = Schema.Literals([
  "derive-environment-hash",
  "check-tunnel-limit",
  "reserve-allocation",
  "ensure-tunnel",
  "validate-tunnel-response",
  "record-tunnel",
  "configure-tunnel",
  "ensure-dns-record",
  "record-dns",
  "get-tunnel-token",
  "mark-allocation-ready",
  "load-allocation",
  "verify-endpoint",
  "verify-tunnel",
  "sync-origin",
]);

const ManagedEndpointProvisioningFailureReason = Schema.Literals([
  "claim-lost",
  "endpoint-mismatch",
  "invalid-tunnel-response",
]);

export class ManagedEndpointProvisioningFailed extends Schema.TaggedError<ManagedEndpointProvisioningFailed>()(
  "ManagedEndpointProvisioningFailed",
  {
    stage: ManagedEndpointProvisioningStage,
    reason: Schema.optionalKey(ManagedEndpointProvisioningFailureReason),
    userId: Schema.String,
    environmentId: Schema.String,
    hostname: Schema.optionalKey(Schema.String),
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    returnedTunnelName: Schema.optionalKey(Schema.String),
    returnedTunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Managed endpoint provisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

const ManagedEndpointDeprovisioningStage = Schema.Literals([
  "load-allocation",
  "load-tunnel",
  "claim-release",
  "claim-deprovision",
  "delete-dns-record",
  "delete-tunnel",
  "remove-allocation",
]);

export class ManagedEndpointDeprovisioningFailed extends Schema.TaggedError<ManagedEndpointDeprovisioningFailed>()(
  "ManagedEndpointDeprovisioningFailed",
  {
    stage: ManagedEndpointDeprovisioningStage,
    userId: Schema.String,
    environmentId: Schema.String,
    tunnelId: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed endpoint deprovisioning failed during '${this.stage}' for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export class ManagedEndpointOriginNotAllowed extends Schema.TaggedError<ManagedEndpointOriginNotAllowed>()(
  "ManagedEndpointOriginNotAllowed",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    host: Schema.String,
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `Managed endpoint origin '${this.host}:${this.port}' is not allowed for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed
  | ManagedTunnelLimits.ManagedTunnelLimitExceeded;

export type ManagedEndpointProvisioningResult = {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
} & (
  | { readonly kind: "linked"; readonly environmentCredential: string }
  | { readonly kind: "recovered" }
);

export type ManagedEndpointOriginSyncResult = "ready" | "recovery_required";

export type ManagedEndpointDeprovisionTarget = Target;

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  {
    readonly provision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly publication: ProvisionPublication;
    }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
    readonly reconcileOrigin: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
      readonly expectedLink: ExpectedManagedLink;
    }) => Effect.Effect<ManagedEndpointOriginSyncResult, ManagedEndpointProviderError>;
    readonly deprovision: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly target: ManagedEndpointDeprovisionTarget | null;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
    /**
     * Deletes the billed tunnel while retaining its allocation, name and DNS for recreation.
     * True requires confirmed absence or never-created history; busy/stale owners return false.
     * Ambiguous outcomes retain the reservation and require explicit repair.
     */
    readonly release: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly expectedTunnelId?: string;
      readonly expectedTarget?: Target;
      readonly expectedInactiveBefore?: string;
      readonly expectedStatus?: "inactive" | "down";
      readonly markReleased?: boolean;
    }) => Effect.Effect<boolean, ManagedEndpointDeprovisioningFailed>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider") {}

export interface ManagedEndpointTunnel {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly status?: string | null;
  readonly createdAt?: string | null;
  readonly connsInactiveAt?: string | null;
  readonly deletedAt?: string | null;
}

export interface ManagedEndpointTunnelListRequest {
  readonly isDeleted: false;
  readonly name?: string;
  readonly includePrefix?: string;
  readonly status?: "inactive" | "down";
  readonly existedAt?: string;
  readonly wasInactiveAt?: string;
  readonly page?: number;
  readonly perPage?: number;
}

const ManagedEndpointTunnelClientOperation = Schema.Literals([
  "get",
  "list",
  "create",
  "put-configuration",
  "get-token",
  "delete",
]);

export class ManagedEndpointTunnelClientError extends Schema.TaggedError<ManagedEndpointTunnelClientError>()(
  "ManagedEndpointTunnelClientError",
  {
    operation: ManagedEndpointTunnelClientOperation,
    tunnelName: Schema.optionalKey(Schema.String),
    tunnelId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.tunnelId ?? this.tunnelName;
    return `Managed endpoint tunnel provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export class ManagedEndpointTunnelClient extends Context.Service<
  ManagedEndpointTunnelClient,
  {
    readonly get: (
      tunnelId: string,
    ) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly list: (request: ManagedEndpointTunnelListRequest) => Effect.Effect<
      {
        readonly result: ReadonlyArray<ManagedEndpointTunnel>;
        readonly resultInfo?: ResultInfo | null;
      },
      ManagedEndpointTunnelClientError
    >;
    readonly create: (request: {
      readonly name: string;
      readonly configSrc: "cloudflare";
    }) => Effect.Effect<ManagedEndpointTunnel, ManagedEndpointTunnelClientError>;
    readonly putConfiguration: (
      tunnelId: string,
      config: {
        readonly ingress: Array<{
          readonly hostname?: string;
          readonly service: string;
        }>;
      },
    ) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
    readonly getToken: (
      tunnelId: string,
    ) => Effect.Effect<string, ManagedEndpointTunnelClientError>;
    readonly delete: (tunnelId: string) => Effect.Effect<unknown, ManagedEndpointTunnelClientError>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider/ManagedEndpointTunnelClient") {}

export const layerTunnelClient = (client: ManagedEndpointTunnelClient["Service"]) =>
  Layer.succeed(ManagedEndpointTunnelClient, client);

interface ManagedEndpointCnameRecordInput {
  readonly type: "CNAME";
  readonly name: string;
  readonly content: string;
  readonly ttl: 1;
  readonly proxied: true;
}

const ManagedEndpointDnsClientOperation = Schema.Literals([
  "list-records",
  "get-record",
  "list-records-page",
  "list-exact-records",
  "create-record",
  "update-record",
  "delete-record",
]);

export class ManagedEndpointDnsClientError extends Schema.TaggedError<ManagedEndpointDnsClientError>()(
  "ManagedEndpointDnsClientError",
  {
    operation: ManagedEndpointDnsClientOperation,
    hostname: Schema.optionalKey(Schema.String),
    dnsRecordId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.dnsRecordId ?? this.hostname;
    return `Managed endpoint DNS provider '${this.operation}' request failed${target === undefined ? "" : ` for '${target}'`}`;
  }
}

export interface ManagedEndpointDnsRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: string | null;
  readonly proxied: boolean | null;
}

export interface ManagedEndpointDnsRecordsPage {
  readonly records: ReadonlyArray<ManagedEndpointDnsRecord>;
  readonly resultInfo?: ResultInfo | null;
}

export class ManagedEndpointDnsClient extends Context.Service<
  ManagedEndpointDnsClient,
  {
    readonly getRecord: (
      dnsRecordId: string,
    ) => Effect.Effect<ManagedEndpointDnsRecord, ManagedEndpointDnsClientError>;
    readonly listRecordsPage: (request: {
      readonly hostname: string;
      readonly page: number;
      readonly perPage: number;
    }) => Effect.Effect<ManagedEndpointDnsRecordsPage, ManagedEndpointDnsClientError>;
    readonly listExactRecords: (
      hostname: string,
    ) => Effect.Effect<ReadonlyArray<ManagedEndpointDnsRecord>, ManagedEndpointDnsClientError>;
    readonly listRecords: (
      hostname: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, ManagedEndpointDnsClientError>;
    readonly createRecord: (
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<ManagedEndpointDnsRecord, ManagedEndpointDnsClientError>;
    readonly updateRecord: (
      dnsRecordId: string,
      request: ManagedEndpointCnameRecordInput,
    ) => Effect.Effect<ManagedEndpointDnsRecord, ManagedEndpointDnsClientError>;
    readonly deleteRecord: (
      dnsRecordId: string,
    ) => Effect.Effect<unknown, ManagedEndpointDnsClientError>;
  }
>()("t3code-relay/environments/ManagedEndpointProvider/ManagedEndpointDnsClient") {}

export const layerDnsClient = (client: ManagedEndpointDnsClient["Service"]) =>
  Layer.succeed(ManagedEndpointDnsClient, client);

const requireCloudflareSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfiguration["Service"],
  input: { readonly userId: string; readonly environmentId: string },
) {
  const baseDomain = settings.managedEndpointBaseDomain;
  const namespace = settings.managedEndpointNamespace;
  const missingSettings: Array<"managedEndpointBaseDomain" | "managedEndpointNamespace"> = [];
  if (!baseDomain) {
    missingSettings.push("managedEndpointBaseDomain");
  }
  if (!namespace) {
    missingSettings.push("managedEndpointNamespace");
  }
  if (!baseDomain || !namespace) {
    return yield* new ManagedEndpointProvisioningNotConfigured({
      ...input,
      missingSettings,
    });
  }
  return {
    baseDomain,
    namespace,
  };
});

function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

const isTunnelClientError = Schema.is(ManagedEndpointTunnelClientError);
const isDnsClientError = Schema.is(ManagedEndpointDnsClientError);
// The SDK's lite errors are classes rather than Effect schemas in beta.84.
// Preserve concrete SDK provenance before accepting absence or duplicate evidence.
const isTunnelNotFound = (error: unknown): error is TunnelNotFound =>
  error instanceof TunnelNotFound;
const isRecordNotFound = (error: unknown): error is RecordNotFound =>
  error instanceof RecordNotFound;
const isDuplicateTunnelName = (error: unknown): error is DuplicateTunnelName =>
  error instanceof DuplicateTunnelName;
const isDnsRecordAlreadyExists = (error: unknown): error is DnsRecordAlreadyExists =>
  error instanceof DnsRecordAlreadyExists;

// Only a direct operation wrapper and an actual SDK error are admissible.
const tunnelAbsent = (error: unknown, operation: ManagedEndpointTunnelClientError["operation"]) =>
  isTunnelClientError(error) && error.operation === operation && isTunnelNotFound(error.cause);
const dnsAbsent = (error: unknown, operation: ManagedEndpointDnsClientError["operation"]) =>
  isDnsClientError(error) &&
  error.operation === operation &&
  isRecordNotFound(error.cause) &&
  error.cause.code === 81044;
const duplicateTunnel = (error: unknown) =>
  isTunnelClientError(error) &&
  error.operation === "create" &&
  isDuplicateTunnelName(error.cause) &&
  error.cause.code === 1013;
const duplicateDns = (error: unknown) =>
  isDnsClientError(error) &&
  error.operation === "create-record" &&
  isDnsRecordAlreadyExists(error.cause) &&
  (error.cause.code === 81057 || error.cause.code === 81058);

// The pinned tunnel-delete operation declares no terminal in-use error.
// Generic message/code failures cannot establish external quiescence.
export class CloudflareApiPaused extends Schema.TaggedError<CloudflareApiPaused>()(
  "CloudflareApiPaused",
  { retryAfterMillis: Schema.Number },
) {
  override get message(): string {
    return `Cloudflare API calls are paused for ${this.retryAfterMillis}ms after a rate limit`;
  }
}

export function isCloudflareRateLimited(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }
  if (
    "_tag" in cause &&
    (cause._tag === "TooManyRequests" ||
      cause._tag === "CloudflareRateLimited" ||
      cause._tag === "CloudflareApiPaused")
  ) {
    return true;
  }
  if ("status" in cause && cause.status === 429) {
    return true;
  }
  return "cause" in cause && isCloudflareRateLimited(cause.cause);
}

const CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE = Duration.seconds(30);
const CLOUDFLARE_MAX_RATE_LIMIT_PAUSE = Duration.minutes(2);

function cloudflareRateLimitPauseMillis(cause: unknown): number {
  const retryAfter =
    typeof cause === "object" && cause !== null && "retryAfter" in cause
      ? cause.retryAfter
      : undefined;
  const pause = Duration.isDuration(retryAfter) ? retryAfter : CLOUDFLARE_DEFAULT_RATE_LIMIT_PAUSE;
  return Duration.toMillis(Duration.min(pause, CLOUDFLARE_MAX_RATE_LIMIT_PAUSE));
}

/**
 * How long a caller should wait before retrying, when `cause` is a Cloudflare
 * rate limit or a call refused during the pause that follows one.
 */
export function cloudflareRetryAfterMillis(cause: unknown): number | undefined {
  for (let current = cause, depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("_tag" in current && current._tag === "CloudflareApiPaused") {
      const retryAfterMillis: unknown = Reflect.get(current, "retryAfterMillis");
      return typeof retryAfterMillis === "number" ? retryAfterMillis : undefined;
    }
    if (
      ("_tag" in current &&
        (current._tag === "TooManyRequests" || current._tag === "CloudflareRateLimited")) ||
      ("status" in current && current.status === 429)
    ) {
      return cloudflareRateLimitPauseMillis(current);
    }
    if (!("cause" in current)) return undefined;
    current = current.cause;
  }
  return undefined;
}

// The SDK's default policy sleeps through Retry-After inside the request, which
// held every caller until its timeout and kept the account over its limit.
// Rate limits surface at once instead; other transient failures still retry.
const withoutRateLimitRetries: CloudflareRetry.Factory = (lastError) => {
  const defaults = CloudflareRetry.makeDefault(lastError);
  return {
    ...defaults,
    while: (error) => !isCloudflareRateLimited(error) && (defaults.while?.(error) ?? false),
  };
};

// Every isolate rereads the shared pause at most this often, so a quiet
// period costs one query per isolate rather than one per Cloudflare call.
const CLOUDFLARE_PAUSE_REFRESH_MILLIS = 5_000;

/**
 * The rate limit is account-wide, so once one call is rejected every other
 * call is too, from any isolate. Failing them without a request leaves the
 * account room to recover instead of extending the limit.
 */
export const makeCloudflareApiGate = (alchemyRuntimeContext: Alchemy.BaseRuntimeContext) => {
  let pausedUntilMillis = 0;
  let checkedAtMillis = Number.NEGATIVE_INFINITY;
  return (pause: CloudflareApiPause.CloudflareApiPause["Service"]) => {
    const recordRateLimit = Effect.fn("relay.cloudflare_api_pause.rate_limited")(function* (
      cause: unknown,
    ) {
      const pauseMillis = cloudflareRateLimitPauseMillis(cause);
      const until = (yield* Clock.currentTimeMillis) + pauseMillis;
      pausedUntilMillis = Math.max(pausedUntilMillis, until);
      yield* Effect.annotateCurrentSpan({ "relay.cloudflare.pause_ms": pauseMillis });
      yield* pause.pauseUntil(until);
    });
    return <A, E>(
      call: Effect.Effect<A, E, Alchemy.RuntimeContext>,
    ): Effect.Effect<A, E | CloudflareApiPaused | Cause.TimeoutError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now >= pausedUntilMillis && now - checkedAtMillis >= CLOUDFLARE_PAUSE_REFRESH_MILLIS) {
          checkedAtMillis = now;
          // Read first: a 429 recorded while the read is in flight must win.
          const shared = yield* pause.pausedUntilMillis;
          pausedUntilMillis = Math.max(pausedUntilMillis, shared);
        }
        // A paused call never reaches Cloudflare, so it leaves no 429 behind.
        // Its own span keeps a storm visible to the rate-limit monitors.
        if (now < pausedUntilMillis) {
          return yield* new CloudflareApiPaused({ retryAfterMillis: pausedUntilMillis - now }).pipe(
            Effect.withSpan("relay.cloudflare_api_pause.rejected"),
          );
        }
        return yield* call.pipe(
          Effect.provideService(CloudflareRetry.Retry, withoutRateLimitRetries),
          Effect.timeout("8 seconds"),
          Effect.tapError((cause) =>
            isCloudflareRateLimited(cause) ? recordRateLimit(cause) : Effect.void,
          ),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        );
      });
  };
};

class RuntimeConflict extends Schema.TaggedError<RuntimeConflict>()(
  "ManagedEndpointRuntimeConflict",
  {
    reason: Schema.String,
  },
) {}
const conflict = (reason: string) => Effect.fail(new RuntimeConflict({ reason }));
const absentPresence = (presence: ResourcePresence) =>
  presence === "absent" || presence === "never_created";
const validateTunnel = (
  tunnel: ManagedEndpointTunnel,
  name: string,
  id?: string,
): Effect.Effect<
  ManagedEndpointTunnel & { readonly id: string; readonly name: string },
  RuntimeConflict
> =>
  typeof tunnel.id === "string" &&
  tunnel.id.length > 0 &&
  tunnel.id.length <= 191 &&
  !/\s/u.test(tunnel.id) &&
  tunnel.name === name &&
  (id === undefined || tunnel.id === id) &&
  tunnel.deletedAt == null
    ? Effect.succeed({ ...tunnel, id: tunnel.id, name })
    : conflict("Tunnel identity conflict");
const validateDns = (
  record: ManagedEndpointDnsRecord,
  hostname: string,
  tunnelId: string,
  id?: string,
): Effect.Effect<ManagedEndpointDnsRecord, RuntimeConflict> =>
  record.id.length > 0 &&
  record.id.length <= 191 &&
  !/\s/u.test(record.id) &&
  record.name === hostname &&
  record.type === "CNAME" &&
  record.content === `${tunnelId}.cfargotunnel.com` &&
  record.proxied === true &&
  (id === undefined || id === record.id)
    ? Effect.succeed(record)
    : conflict("DNS identity conflict");

const ConfigurationResponse = Schema.Struct({
  tunnelId: Schema.String,
  config: Schema.Struct({
    ingress: Schema.Array(
      Schema.Struct({ hostname: Schema.optionalKey(Schema.String), service: Schema.String }),
    ),
  }),
});
const DeletedTunnelResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  deletedAt: Schema.String,
});
const DeletedDnsResponse = Schema.Struct({ id: Schema.String });
const decodeConfigurationResponse = Schema.decodeUnknownEffect(ConfigurationResponse);
const decodeDeletedTunnelResponse = Schema.decodeUnknownEffect(DeletedTunnelResponse);
const decodeDeletedDnsResponse = Schema.decodeUnknownEffect(DeletedDnsResponse);
const validateConfiguration = (
  response: unknown,
  tunnelId: string,
  expected: {
    readonly ingress: ReadonlyArray<{ readonly hostname?: string; readonly service: string }>;
  },
): Effect.Effect<MutationOutcome, RuntimeConflict> =>
  decodeConfigurationResponse(response).pipe(
    Effect.mapError(
      () => new RuntimeConflict({ reason: "Malformed configuration acknowledgement" }),
    ),
    Effect.filterOrFail(
      (actual) =>
        actual.tunnelId === tunnelId &&
        actual.config.ingress.length === expected.ingress.length &&
        actual.config.ingress.every(
          (entry, index) =>
            entry.hostname === expected.ingress[index]?.hostname &&
            entry.service === expected.ingress[index]?.service,
        ),
      () => new RuntimeConflict({ reason: "Configuration acknowledgement identity conflict" }),
    ),
    Effect.as({ action: "configure_tunnel", tunnelId }),
  );
const validateDeletedTunnel = (
  response: unknown,
  tunnelId: string,
  tunnelName: string,
): Effect.Effect<MutationOutcome, RuntimeConflict> =>
  decodeDeletedTunnelResponse(response).pipe(
    Effect.mapError(
      () => new RuntimeConflict({ reason: "Malformed tunnel deletion acknowledgement" }),
    ),
    Effect.filterOrFail(
      (actual) =>
        actual.id === tunnelId &&
        actual.name === tunnelName &&
        Option.isSome(DateTime.make(actual.deletedAt)),
      () => new RuntimeConflict({ reason: "Tunnel deletion acknowledgement identity conflict" }),
    ),
    Effect.as({ action: "delete_tunnel", tunnelId }),
  );
const validateDeletedDns = (
  response: unknown,
  dnsRecordId: string,
): Effect.Effect<MutationOutcome, RuntimeConflict> =>
  decodeDeletedDnsResponse(response).pipe(
    Effect.mapError(
      () => new RuntimeConflict({ reason: "Malformed DNS deletion acknowledgement" }),
    ),
    Effect.filterOrFail(
      (actual) => actual.id === dnsRecordId,
      () => new RuntimeConflict({ reason: "DNS deletion acknowledgement identity conflict" }),
    ),
    Effect.as({ action: "delete_dns", dnsRecordId }),
  );

const originSchema = Schema.Struct({
  localHttpHost: Schema.Literals(["localhost", "127.0.0.1", "::1", "[::1]"]),
  localHttpPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});
const decodeRuntimeOrigin = Schema.decodeUnknownEffect(originSchema);

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const db = yield* RelayDb.RelayDb;
  const tunnels = yield* ManagedEndpointTunnelClient;
  const dns = yield* ManagedEndpointDnsClient;
  const lifecycle = yield* ManagedEndpointLifecycle.ManagedEndpointLifecycle;
  const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;

  const rejectAmbient = Effect.gen(function* () {
    if (yield* transactionActive(db)) return yield* conflict("Ambient SQL transaction rejected");
  });
  const requireApplied = (result: TransitionResult) =>
    result.status === "Applied" ? Effect.void : conflict("Lifecycle checkpoint lost");
  const acquire = (
    row: ManagedEndpointLifecycle.LifecycleAllocation,
    kind: OperationKind,
    purpose?: AcquisitionPurpose,
    target = targetFor(row),
  ) =>
    lifecycle.acquireOperation({
      key: row,
      kind,
      expectedTarget: target,
      ...(purpose ? { purpose } : {}),
    });

  // This mask protects only finite durable boundaries. External effects are
  // restored and joined through their full Exit, including defects/interrupts.
  // Safe is cleared BEFORE each write, so an unknown COMMIT never releases ownership.
  const owned = Effect.fn("ManagedEndpointProvider.owned")(function* <A, E, R>(
    claim: Claim,
    restore: <B, F, S>(effect: Effect.Effect<B, F, S>) => Effect.Effect<B, F, S>,
    body: (owner: {
      readonly durable: <B, F, S>(effect: Effect.Effect<B, F, S>) => Effect.Effect<B, F, S>;
      readonly read: <B, F, S>(effect: Effect.Effect<B, F, S>) => Effect.Effect<B, F, S>;
      readonly mutation: <B, F>(
        action: MutationAction,
        dispatch: () => Effect.Effect<B, F>,
        validate: (value: B) => Effect.Effect<MutationOutcome, RuntimeConflict>,
        rejected?: (error: F) => boolean,
      ) => Effect.Effect<
        B | null,
        F | RuntimeConflict | ManagedEndpointLifecycle.LifecyclePersistenceError
      >;
    }) => Effect.Effect<A, E, R>,
  ) {
    let safe = true;
    const durable = Effect.fn("ManagedEndpointProvider.durable")(function* <B, F, S>(
      effect: Effect.Effect<B, F, S>,
    ) {
      safe = false;
      const value = yield* effect;
      safe = true;
      return value;
    });
    const mutation = Effect.fn("ManagedEndpointProvider.mutation")(function* <B, F>(
      action: MutationAction,
      dispatch: () => Effect.Effect<B, F>,
      validate: (value: B) => Effect.Effect<MutationOutcome, RuntimeConflict>,
      rejected?: (error: F) => boolean,
    ) {
      safe = false;
      const intent = yield* lifecycle.beginMutation({ claim, mutation: action });
      if (intent.status !== "Applied") {
        safe = true;
        return yield* conflict("Lifecycle mutation intent lost");
      }
      const exit = yield* Effect.exit(restore(Effect.suspend(dispatch)));
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0];
        if (
          exit.cause.reasons.length === 1 &&
          reason !== undefined &&
          Cause.isFailReason(reason) &&
          rejected?.(reason.error)
        ) {
          yield* requireApplied(
            yield* lifecycle.completeMutation({
              claim,
              stepId: intent.stepId,
              outcome: { action: "rejected_no_effect" },
            }),
          );
          safe = true;
          return null;
        }
        return yield* Effect.failCause(exit.cause);
      }
      const outcome = yield* validate(exit.value);
      yield* requireApplied(
        yield* lifecycle.completeMutation({ claim, stepId: intent.stepId, outcome }),
      );
      safe = true;
      return exit.value;
    });
    const exit = yield* Effect.exit(body({ durable, read: restore, mutation }));
    if (Exit.isFailure(exit)) {
      // No finalizer ever guesses that an in-flight/unknown dispatch is gone.
      yield* (safe ? lifecycle.finishIdle(claim) : lifecycle.retainUncertain(claim)).pipe(
        Effect.ignore,
      );
      return yield* Effect.failCause(exit.cause);
    }
    return exit.value;
  });

  const observe = (claim: Claim, observation: Observation) =>
    lifecycle.recordObservation({ claim, observation });
  const freshRow = (claim: Claim) =>
    lifecycle.get(claim).pipe(
      Effect.filterOrFail(
        (row): row is ManagedEndpointLifecycle.LifecycleAllocation => row !== null,
        () => new RuntimeConflict({ reason: "Allocation absent" }),
      ),
    );
  const exactTunnels = Effect.fn("ManagedEndpointProvider.exactTunnels")(function* (name: string) {
    const result: Array<ManagedEndpointTunnel & { readonly id: string; readonly name: string }> =
      [];
    const ids = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const response = yield* tunnels.list({ isDeleted: false, name, page, perPage: 100 });
      const info = response.resultInfo;
      const count = info?.count;
      const totalCount = info?.totalCount;
      if (
        !info ||
        typeof count !== "number" ||
        typeof totalCount !== "number" ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(totalCount) ||
        totalCount < 0 ||
        totalCount > 1_000 ||
        info.page !== page ||
        info.perPage !== 100 ||
        count !== response.result.length ||
        count !== Math.min(100, Math.max(0, totalCount - (page - 1) * 100)) ||
        (info.totalPages != null &&
          info.totalPages !== Math.ceil(totalCount / 100) &&
          !(totalCount === 0 && info.totalPages === 1)) ||
        info.cursor != null ||
        info.cursors != null ||
        (total !== undefined && total !== totalCount)
      )
        return yield* conflict("Incomplete tunnel inventory");
      total = totalCount;
      for (const item of response.result) {
        const tunnel = yield* validateTunnel(item, name);
        if (ids.has(tunnel.id)) return yield* conflict("Duplicate tunnel identity");
        ids.add(tunnel.id);
        result.push(tunnel);
      }
      if (page >= Math.max(1, Math.ceil(totalCount / 100))) return result;
    }
    return yield* conflict("Tunnel inventory budget exhausted");
  });
  const readTunnel = Effect.fn("ManagedEndpointProvider.readTunnel")(function* (
    row: ManagedEndpointLifecycle.LifecycleAllocation,
  ) {
    if (row.tunnelId === null) return null;
    return yield* tunnels.get(row.tunnelId).pipe(
      Effect.flatMap((value) => validateTunnel(value, row.tunnelName, row.tunnelId ?? undefined)),
      Effect.catchIf(
        (error) => tunnelAbsent(error, "get"),
        () => Effect.succeed(null),
      ),
    );
  });
  const readDns = Effect.fn("ManagedEndpointProvider.readDns")(function* (
    row: ManagedEndpointLifecycle.LifecycleAllocation,
  ) {
    if (row.dnsRecordId === null) return null;
    const record = yield* dns.getRecord(row.dnsRecordId).pipe(
      Effect.catchIf(
        (error) => dnsAbsent(error, "get-record"),
        () => Effect.succeed(null),
      ),
    );
    if (record === null) return null;
    if (row.dnsTargetTunnelId === null) return yield* conflict("Unresolved DNS target");
    return yield* validateDns(record, row.hostname, row.dnsTargetTunnelId, row.dnsRecordId);
  });
  const provisioningError =
    (key: AllocationKey, stage: ManagedEndpointProvisioningFailed["stage"]) => (cause: unknown) =>
      new ManagedEndpointProvisioningFailed({ ...key, stage, cause });
  const cleanupError =
    (key: AllocationKey, stage: ManagedEndpointDeprovisioningFailed["stage"]) => (cause: unknown) =>
      new ManagedEndpointDeprovisioningFailed({ ...key, stage, cause });
  const validateOrigin = (input: AllocationKey & { readonly origin: RelayManagedEndpointOrigin }) =>
    decodeRuntimeOrigin(input.origin).pipe(
      Effect.mapError(
        () =>
          new ManagedEndpointOriginNotAllowed({
            ...input,
            host: input.origin.localHttpHost,
            port: input.origin.localHttpPort,
          }),
      ),
    );
  const configuration = (hostname: string, origin: RelayManagedEndpointOrigin) => ({
    ingress: [{ hostname, service: formatOriginService(origin) }, { service: "http_status:404" }],
  });

  return ManagedEndpointProvider.of({
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* rejectAmbient.pipe(Effect.mapError(provisioningError(input, "reserve-allocation")));
      const origin = yield* validateOrigin(input);
      if (
        input.publication.kind === "link" &&
        (input.publication.proof.environmentId !== input.environmentId ||
          input.publication.proof.sub !== input.environmentId ||
          input.publication.proof.descriptor.environmentId !== input.environmentId ||
          input.publication.proof.environmentPublicKey.length === 0 ||
          !input.publication.request.managedTunnelsEnabled ||
          !input.publication.proof.scopes.includes("managed_tunnels") ||
          ((input.publication.request.notificationsEnabled ||
            input.publication.request.liveActivitiesEnabled) &&
            !input.publication.proof.scopes.includes("agent_activity_notifications")) ||
          input.publication.proof.origin.localHttpHost !== input.origin.localHttpHost ||
          input.publication.proof.origin.localHttpPort !== input.origin.localHttpPort)
      )
        return yield* provisioningError(
          input,
          "verify-endpoint",
        )(new RuntimeConflict({ reason: "Invalid verified publication" }));
      const settings = yield* requireCloudflareSettings(config, input);
      const digest = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            managedEndpointDigestInput(settings.namespace, input.userId, input.environmentId),
          ),
        )
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(provisioningError(input, "derive-environment-hash")),
        );
      const hostname = managedEndpointHostname(settings.namespace, settings.baseDomain, digest);
      const tunnelName = managedEndpointTunnelName(settings.namespace, digest);
      // Only admission inserts known-fresh idle. Existing rows are never reset.
      const reserved = yield* limits.reserveAllocation({ ...input, hostname, tunnelName }).pipe(
        Effect.catchTags({
          ManagedTunnelLimitPersistenceError: (cause) =>
            Effect.fail(provisioningError(input, "reserve-allocation")(cause)),
        }),
      );
      const purpose: AcquisitionPurpose =
        input.publication.kind === "link"
          ? { kind: "link" }
          : { ...input.publication, kind: "recover" };
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acquired = yield* acquire(reserved, "provision", purpose);
          if (acquired.status !== "Acquired")
            return yield* conflict(`Acquisition ${acquired.status}`);
          const { claim } = acquired;
          return yield* Effect.uninterruptible(
            owned(claim, restore, ({ durable, read, mutation }) =>
              Effect.gen(function* () {
                let row = acquired.allocation;
                let tunnel = yield* read(readTunnel(row));
                if (tunnel === null && row.tunnelId !== null) {
                  yield* requireApplied(
                    yield* durable(
                      observe(claim, {
                        resource: "tunnel",
                        presence: "absent",
                        tunnelId: row.tunnelId,
                      }),
                    ),
                  );
                  row = yield* freshRow(claim);
                }
                const discover = Effect.gen(function* () {
                  const candidates = yield* read(exactTunnels(row.tunnelName));
                  if (candidates.length > 1) return yield* conflict("Multiple exact-name tunnels");
                  const candidate = candidates[0];
                  if (candidate) {
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, {
                          resource: "tunnel",
                          presence: "recorded",
                          tunnelId: candidate.id,
                          tunnelName: candidate.name,
                        }),
                      ),
                    );
                    return candidate;
                  }
                  if (row.tunnelId === null && row.tunnelPresence === "unresolved")
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, { resource: "tunnel", presence: "never_created" }),
                      ),
                    );
                  return null;
                });
                if (tunnel === null) tunnel = yield* discover;
                if (tunnel === null) {
                  const created = yield* mutation(
                    { action: "create_tunnel", tunnelName: row.tunnelName },
                    () => tunnels.create({ name: row.tunnelName, configSrc: "cloudflare" }),
                    (value) =>
                      validateTunnel(value, row.tunnelName).pipe(
                        Effect.map((valid) => ({
                          action: "create_tunnel" as const,
                          tunnelId: valid.id,
                          tunnelName: valid.name,
                        })),
                      ),
                    duplicateTunnel,
                  );
                  if (created === null) {
                    tunnel = yield* discover;
                    if (tunnel === null)
                      return yield* conflict("Duplicate tunnel not found in complete inventory");
                  } else tunnel = yield* validateTunnel(created, row.tunnelName);
                }
                const tunnelId = tunnel.id;
                const configured = yield* mutation(
                  { action: "configure_tunnel", tunnelId, tunnelName: row.tunnelName, origin },
                  () =>
                    tunnels.putConfiguration(tunnelId, configuration(row.hostname, input.origin)),
                  (value) =>
                    validateConfiguration(
                      value,
                      tunnelId,
                      configuration(row.hostname, input.origin),
                    ),
                  (error) => tunnelAbsent(error, "put-configuration"),
                );
                if (configured === null) {
                  yield* requireApplied(
                    yield* durable(
                      observe(claim, { resource: "tunnel", presence: "absent", tunnelId }),
                    ),
                  );
                  return yield* conflict(
                    "Tunnel disappeared during configuration; recovery required",
                  );
                }
                row = yield* freshRow(claim);
                let record = yield* read(readDns(row));
                if (record === null && row.dnsRecordId !== null) {
                  yield* requireApplied(
                    yield* durable(
                      observe(claim, {
                        resource: "dns",
                        presence: "absent",
                        dnsRecordId: row.dnsRecordId,
                      }),
                    ),
                  );
                  row = yield* freshRow(claim);
                }
                const discoverDns = Effect.gen(function* () {
                  const candidates = yield* read(dns.listExactRecords(row.hostname));
                  if (candidates.length > 1) return yield* conflict("Multiple exact DNS records");
                  const candidate = candidates[0];
                  if (candidate) {
                    const previous =
                      candidate.content === `${tunnelId}.cfargotunnel.com`
                        ? tunnelId
                        : row.dnsTargetTunnelId;
                    if (previous === null) return yield* conflict("Foreign DNS record");
                    yield* validateDns(candidate, row.hostname, previous);
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, {
                          resource: "dns",
                          presence: "recorded",
                          dnsRecordId: candidate.id,
                          hostname: row.hostname,
                          tunnelId: previous,
                        }),
                      ),
                    );
                    return candidate;
                  }
                  if (row.dnsRecordId === null && row.dnsPresence === "unresolved")
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, { resource: "dns", presence: "never_created" }),
                      ),
                    );
                  return null;
                });
                if (record === null) record = yield* discoverDns;
                const cname: ManagedEndpointCnameRecordInput = {
                  type: "CNAME",
                  name: row.hostname,
                  content: `${tunnelId}.cfargotunnel.com`,
                  ttl: 1,
                  proxied: true,
                };
                if (record === null) {
                  record = yield* mutation(
                    { action: "create_dns", hostname: row.hostname, tunnelId },
                    () => dns.createRecord(cname),
                    (value) =>
                      validateDns(value, row.hostname, tunnelId).pipe(
                        Effect.map((valid) => ({
                          action: "create_dns" as const,
                          dnsRecordId: valid.id,
                          hostname: row.hostname,
                          tunnelId,
                        })),
                      ),
                    duplicateDns,
                  );
                  if (record === null) {
                    record = yield* discoverDns;
                    if (record === null)
                      return yield* conflict("Duplicate DNS record absent from complete inventory");
                  }
                }
                if (record.content !== cname.content || record.proxied !== true) {
                  row = yield* freshRow(claim);
                  if (row.dnsTargetTunnelId === null)
                    return yield* conflict("Unresolved previous DNS target");
                  yield* mutation(
                    {
                      action: "update_dns",
                      dnsRecordId: record.id,
                      hostname: row.hostname,
                      previousTunnelId: row.dnsTargetTunnelId,
                      nextTunnelId: tunnelId,
                    },
                    () => dns.updateRecord(record.id, cname),
                    (value) =>
                      validateDns(value, row.hostname, tunnelId, record?.id).pipe(
                        Effect.map((valid) => ({
                          action: "update_dns" as const,
                          dnsRecordId: valid.id,
                          hostname: row.hostname,
                          tunnelId,
                        })),
                      ),
                  );
                }
                const connectorToken = yield* read(tunnels.getToken(tunnelId));
                if (
                  typeof connectorToken !== "string" ||
                  connectorToken.length === 0 ||
                  /\s/u.test(connectorToken)
                )
                  return yield* conflict("Invalid connector token");
                const published = yield* durable(
                  lifecycle.publishProvision({
                    claim,
                    origin: input.origin,
                    publication: input.publication,
                  }),
                );
                if (published.status !== "Applied") return yield* conflict("Publication lost");
                const runtime = {
                  providerKind: "cloudflare_tunnel" as const,
                  connectorToken,
                  tunnelId,
                  tunnelName: tunnel.name,
                };
                return published.kind === "link"
                  ? {
                      kind: "linked" as const,
                      endpoint: published.endpoint,
                      runtime,
                      environmentCredential: published.environmentCredential,
                    }
                  : { kind: "recovered" as const, endpoint: published.endpoint, runtime };
              }),
            ),
          );
        }),
      ).pipe(
        Effect.mapError(provisioningError(input, "ensure-tunnel")),
        Effect.catchDefect((cause) =>
          Effect.fail(provisioningError(input, "ensure-tunnel")(cause)),
        ),
      );
    }),
    reconcileOrigin: Effect.fn("relay.managed_endpoint_provider.reconcile_origin")(
      function* (input) {
        yield* rejectAmbient.pipe(Effect.mapError(provisioningError(input, "load-allocation")));
        const origin = yield* validateOrigin(input);
        yield* requireCloudflareSettings(config, input);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const row = yield* lifecycle.get(input);
            if (!row || row.tunnelId !== input.tunnelId) return "recovery_required" as const;
            const acquired = yield* acquire(row, "reconcile", {
              kind: "reconcile",
              ...input.expectedLink,
            });
            if (acquired.status !== "Acquired")
              return yield* conflict(`Acquisition ${acquired.status}`);
            const { claim } = acquired;
            return yield* Effect.uninterruptible(
              owned(claim, restore, ({ durable, read, mutation }) =>
                Effect.gen(function* () {
                  const tunnel = yield* read(readTunnel(acquired.allocation));
                  if (tunnel === null) {
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, {
                          resource: "tunnel",
                          presence: "absent",
                          tunnelId: input.tunnelId,
                        }),
                      ),
                    );
                    yield* requireApplied(yield* durable(lifecycle.finishIdle(claim)));
                    return "recovery_required" as const;
                  }
                  const record = yield* read(readDns(acquired.allocation));
                  if (record === null || acquired.allocation.dnsTargetTunnelId !== input.tunnelId)
                    return yield* conflict("DNS not ready");
                  const prior = acquired.allocation.origin;
                  if (
                    prior?.localHttpHost !== input.origin.localHttpHost ||
                    prior.localHttpPort !== input.origin.localHttpPort
                  ) {
                    const configured = yield* mutation(
                      {
                        action: "configure_tunnel",
                        tunnelId: input.tunnelId,
                        tunnelName: tunnel.name,
                        origin,
                      },
                      () =>
                        tunnels.putConfiguration(
                          input.tunnelId,
                          configuration(row.hostname, input.origin),
                        ),
                      (value) =>
                        validateConfiguration(
                          value,
                          input.tunnelId,
                          configuration(row.hostname, input.origin),
                        ),
                      (error) => tunnelAbsent(error, "put-configuration"),
                    );
                    if (configured === null) {
                      yield* requireApplied(
                        yield* durable(
                          observe(claim, {
                            resource: "tunnel",
                            presence: "absent",
                            tunnelId: input.tunnelId,
                          }),
                        ),
                      );
                      yield* requireApplied(yield* durable(lifecycle.finishIdle(claim)));
                      return "recovery_required" as const;
                    }
                  }
                  yield* requireApplied(
                    yield* durable(
                      lifecycle.completeReconcile({
                        claim,
                        origin: input.origin,
                        expectedLink: input.expectedLink,
                      }),
                    ),
                  );
                  return "ready" as const;
                }),
              ),
            );
          }),
        ).pipe(
          Effect.mapError(provisioningError(input, "sync-origin")),
          Effect.catchDefect((cause) =>
            Effect.fail(provisioningError(input, "sync-origin")(cause)),
          ),
        );
      },
    ),
    release: Effect.fn("relay.managed_endpoint_provider.release")(function* (input) {
      yield* rejectAmbient.pipe(Effect.mapError(cleanupError(input, "claim-release")));
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const row = yield* lifecycle.get(input);
          if (!row) return true;
          if (input.expectedTunnelId !== undefined && row.tunnelId !== input.expectedTunnelId)
            return false;
          const acquired = yield* acquire(
            row,
            "release",
            undefined,
            input.expectedTarget ?? targetFor(row),
          );
          if (acquired.status !== "Acquired") return false;
          const { claim } = acquired;
          return yield* Effect.uninterruptible(
            owned(claim, restore, ({ durable, read, mutation }) =>
              Effect.gen(function* () {
                const current = acquired.allocation;
                if (!absentPresence(current.tunnelPresence)) {
                  const tunnelId = current.tunnelId;
                  if (tunnelId === null) return yield* conflict("Unresolved null tunnel identity");
                  const tunnel = yield* read(readTunnel(current));
                  if (tunnel === null)
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, {
                          resource: "tunnel",
                          presence: "absent",
                          tunnelId,
                        }),
                      ),
                    );
                  else {
                    if (
                      input.expectedStatus !== undefined ||
                      input.expectedInactiveBefore !== undefined
                    ) {
                      const since =
                        input.expectedStatus === "down" ? tunnel.connsInactiveAt : tunnel.createdAt;
                      const cutoff = DateTime.make(input.expectedInactiveBefore ?? "");
                      const time = typeof since === "string" ? DateTime.make(since) : Option.none();
                      if (
                        tunnel.status !== input.expectedStatus ||
                        Option.isNone(time) ||
                        Option.isNone(cutoff) ||
                        time.value.epochMilliseconds > cutoff.value.epochMilliseconds
                      ) {
                        yield* requireApplied(yield* durable(lifecycle.finishIdle(claim)));
                        return false;
                      }
                    }
                    yield* mutation(
                      {
                        action: "delete_tunnel",
                        tunnelId,
                        tunnelName: current.tunnelName,
                      },
                      () => tunnels.delete(tunnelId),
                      (value) => validateDeletedTunnel(value, tunnelId, current.tunnelName),
                    );
                  }
                }
                yield* requireApplied(
                  yield* durable(
                    lifecycle.finishReleased({
                      claim,
                      ...(input.markReleased === undefined
                        ? {}
                        : { markReleased: input.markReleased }),
                    }),
                  ),
                );
                return true;
              }),
            ),
          );
        }),
      ).pipe(
        Effect.mapError(cleanupError(input, "delete-tunnel")),
        Effect.catchDefect((cause) => Effect.fail(cleanupError(input, "delete-tunnel")(cause))),
      );
    }),
    deprovision: Effect.fn("relay.managed_endpoint_provider.deprovision")(function* (input) {
      yield* rejectAmbient.pipe(Effect.mapError(cleanupError(input, "claim-deprovision")));
      const target = input.target;
      if (target === null) return true;
      if (target.key.userId !== input.userId || target.key.environmentId !== input.environmentId)
        return false;
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const row = yield* lifecycle.get(target.key);
          if (!row) return true;
          const acquired = yield* acquire(row, "deprovision", undefined, target);
          if (acquired.status !== "Acquired") return false;
          const { claim } = acquired;
          return yield* Effect.uninterruptible(
            owned(claim, restore, ({ durable, read, mutation }) =>
              Effect.gen(function* () {
                let current = acquired.allocation;
                if (!current.cleanupRequested) return yield* conflict("Cleanup intent absent");
                // Fresh protocol null IDs may establish absence via complete inventory;
                // legacy/uncertain histories cannot acquire this owner in the first place.
                if (!absentPresence(current.tunnelPresence) && current.tunnelId === null) {
                  const candidates = yield* read(exactTunnels(current.tunnelName));
                  if (candidates.length !== 0)
                    return yield* conflict("Unrecorded tunnel identity requires repair");
                  yield* requireApplied(
                    yield* durable(
                      observe(claim, { resource: "tunnel", presence: "never_created" }),
                    ),
                  );
                }
                if (!absentPresence(current.dnsPresence)) {
                  if (current.dnsRecordId === null) {
                    const records = yield* read(dns.listExactRecords(current.hostname));
                    if (records.length !== 0)
                      return yield* conflict("Unrecorded DNS identity requires repair");
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, { resource: "dns", presence: "never_created" }),
                      ),
                    );
                  } else {
                    const record = yield* read(readDns(current));
                    if (record === null)
                      yield* requireApplied(
                        yield* durable(
                          observe(claim, {
                            resource: "dns",
                            presence: "absent",
                            dnsRecordId: current.dnsRecordId,
                          }),
                        ),
                      );
                    else {
                      if (current.dnsTargetTunnelId === null)
                        return yield* conflict("Unresolved DNS target");
                      yield* mutation(
                        {
                          action: "delete_dns",
                          dnsRecordId: record.id,
                          hostname: current.hostname,
                          previousTunnelId: current.dnsTargetTunnelId,
                        },
                        () => dns.deleteRecord(record.id),
                        (value) => validateDeletedDns(value, record.id),
                        (error) => dnsAbsent(error, "delete-record"),
                      );
                      // A validated typed terminal absence is also a durable fact.
                      current = yield* freshRow(claim);
                      if (current.dnsPresence !== "absent")
                        yield* requireApplied(
                          yield* durable(
                            observe(claim, {
                              resource: "dns",
                              presence: "absent",
                              dnsRecordId: record.id,
                            }),
                          ),
                        );
                    }
                  }
                }
                current = yield* freshRow(claim);
                if (!absentPresence(current.tunnelPresence)) {
                  const tunnelId = current.tunnelId;
                  if (tunnelId === null) return yield* conflict("Unresolved tunnel identity");
                  const tunnel = yield* read(readTunnel(current));
                  if (tunnel === null)
                    yield* requireApplied(
                      yield* durable(
                        observe(claim, {
                          resource: "tunnel",
                          presence: "absent",
                          tunnelId,
                        }),
                      ),
                    );
                  else
                    yield* mutation(
                      {
                        action: "delete_tunnel",
                        tunnelId,
                        tunnelName: current.tunnelName,
                      },
                      () => tunnels.delete(tunnelId),
                      (value) => validateDeletedTunnel(value, tunnelId, current.tunnelName),
                    );
                }
                yield* requireApplied(yield* durable(lifecycle.removeClaimed(claim)));
                return true;
              }),
            ),
          );
        }),
      ).pipe(
        Effect.mapError(cleanupError(input, "remove-allocation")),
        Effect.catchDefect((cause) => Effect.fail(cleanupError(input, "remove-allocation")(cause))),
      );
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);

class InvalidDnsResponse extends Schema.TaggedError<InvalidDnsResponse>()("InvalidDnsResponse", {
  reason: Schema.String,
}) {}

const DnsRecordResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  proxied: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const decodeDnsRecordResponse = Schema.decodeUnknownEffect(DnsRecordResponse);

const decodeExactHostname = (hostname: string) => {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, "");
  const labels = normalized.split(".");
  return normalized.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    ? Effect.succeed(normalized)
    : Effect.fail(new InvalidDnsResponse({ reason: "Invalid DNS hostname" }));
};

const decodeDnsRecord = Effect.fnUntraced(function* (response: unknown) {
  const record = yield* decodeDnsRecordResponse(response);
  const name = yield* decodeExactHostname(record.name);
  if (
    record.id.length === 0 ||
    record.id.length > 256 ||
    /\s/u.test(record.id) ||
    !/^[A-Z][A-Z0-9]*$/u.test(record.type)
  ) {
    return yield* new InvalidDnsResponse({ reason: "Invalid DNS record identity" });
  }
  return {
    id: record.id,
    name,
    type: record.type,
    content: record.content ?? null,
    proxied: record.proxied ?? null,
  } satisfies ManagedEndpointDnsRecord;
});

// A complete inventory is bounded independently of the old single-page lookup.
const DNS_EXACT_PER_PAGE = 100;
const DNS_EXACT_MAX_PAGES = 10;
const DNS_EXACT_MAX_RECORDS = 1_000;

const listExactDnsRecords = Effect.fnUntraced(function* (
  listRecordsPage: ManagedEndpointDnsClient["Service"]["listRecordsPage"],
  hostname: string,
) {
  return yield* Effect.gen(function* () {
    const records: Array<ManagedEndpointDnsRecord> = [];
    const ids = new Set<string>();
    let inventoryTotal: number | undefined;
    let inventoryPages: number | undefined;
    for (let page = 1; page <= DNS_EXACT_MAX_PAGES; page++) {
      const response = yield* listRecordsPage({ hostname, page, perPage: DNS_EXACT_PER_PAGE });
      const info = response.resultInfo;
      if (info === undefined || info === null) {
        return yield* new InvalidDnsResponse({ reason: "Missing DNS pagination metadata" });
      }
      const { count, page: reportedPage, perPage, totalCount, totalPages } = info;
      const values = [
        count,
        reportedPage,
        perPage,
        totalCount,
        ...(totalPages == null ? [] : [totalPages]),
      ];
      if (
        values.some(
          (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
        ) ||
        count === undefined ||
        count === null ||
        reportedPage === undefined ||
        reportedPage === null ||
        perPage === undefined ||
        perPage === null ||
        totalCount === undefined ||
        totalCount === null
      ) {
        return yield* new InvalidDnsResponse({
          reason: "Invalid or incomplete DNS pagination metadata",
        });
      }
      const derivedPages = Math.ceil(totalCount / DNS_EXACT_PER_PAGE);
      // Empty inventories may report zero or one pages; neither requires another read.
      const validPages =
        totalPages == null ||
        (totalCount === 0 ? totalPages === 0 || totalPages === 1 : totalPages === derivedPages);
      const effectivePages = Math.max(1, derivedPages);
      const expectedCount = Math.min(
        DNS_EXACT_PER_PAGE,
        Math.max(0, totalCount - (page - 1) * DNS_EXACT_PER_PAGE),
      );
      if (
        reportedPage !== page ||
        perPage !== DNS_EXACT_PER_PAGE ||
        count !== response.records.length ||
        count !== expectedCount ||
        !validPages ||
        page > effectivePages ||
        totalCount > DNS_EXACT_MAX_RECORDS ||
        effectivePages > DNS_EXACT_MAX_PAGES ||
        (inventoryTotal !== undefined && totalCount !== inventoryTotal) ||
        (inventoryPages !== undefined && effectivePages !== inventoryPages) ||
        info.cursor != null ||
        info.cursors != null
      ) {
        return yield* new InvalidDnsResponse({
          reason: "Contradictory or over-budget DNS pagination",
        });
      }
      inventoryTotal = totalCount;
      inventoryPages = effectivePages;
      for (const record of response.records) {
        if (ids.has(record.id)) {
          return yield* new InvalidDnsResponse({ reason: "Duplicate DNS record identity" });
        }
        ids.add(record.id);
        records.push(record);
      }
      if (page >= effectivePages) {
        if (records.length !== totalCount) {
          return yield* new InvalidDnsResponse({ reason: "Incomplete DNS inventory" });
        }
        return records;
      }
    }
    return yield* new InvalidDnsResponse({ reason: "DNS page budget exhausted" });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ManagedEndpointDnsClientError({ operation: "list-exact-records", hostname, cause }),
    ),
  );
});

export const makeCloudflareTunnelClient = (
  tunnelClient: Pick<
    Cloudflare.Tunnel.ReadWriteTunnelClient,
    "get" | "list" | "create" | "putConfiguration" | "getToken" | "delete"
  >,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
  gate: ReturnType<ReturnType<typeof makeCloudflareApiGate>> = (call) =>
    call.pipe(
      Effect.timeout("8 seconds"),
      Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
    ),
): ManagedEndpointTunnelClient["Service"] =>
  ManagedEndpointTunnelClient.of({
    get: Effect.fn("ManagedEndpointClient.get")((tunnelId) =>
      gate(tunnelClient.get(tunnelId)).pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "get",
              tunnelId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    list: Effect.fn("ManagedEndpointClient.list")((request) =>
      gate(tunnelClient.list(request)).pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "list",
              ...(request.name === undefined ? {} : { tunnelName: request.name }),
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    create: Effect.fn("ManagedEndpointClient.create")((request) =>
      gate(tunnelClient.create(request).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "create",
              tunnelName: request.name,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    putConfiguration: Effect.fn("ManagedEndpointClient.putConfiguration")((tunnelId, config) =>
      gate(tunnelClient.putConfiguration(tunnelId, config).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "put-configuration",
              tunnelId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    getToken: Effect.fn("ManagedEndpointClient.getToken")((tunnelId) =>
      gate(tunnelClient.getToken(tunnelId)).pipe(
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "get-token",
              tunnelId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    delete: Effect.fn("ManagedEndpointClient.delete")((tunnelId) =>
      gate(tunnelClient.delete(tunnelId).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointTunnelClientError({
              operation: "delete",
              tunnelId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
  });

export const makeCloudflareDnsClient = (
  dnsClient: Pick<
    Cloudflare.DNS.ReadWriteDnsClient,
    "getDnsRecord" | "listDnsRecords" | "createDnsRecord" | "updateDnsRecord" | "deleteDnsRecord"
  >,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
  gate: ReturnType<ReturnType<typeof makeCloudflareApiGate>> = (call) =>
    call.pipe(
      Effect.timeout("8 seconds"),
      Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
    ),
): ManagedEndpointDnsClient["Service"] => {
  const getRecord: ManagedEndpointDnsClient["Service"]["getRecord"] = (dnsRecordId) =>
    gate(dnsClient.getDnsRecord(dnsRecordId)).pipe(
      Effect.timeout("8 seconds"),
      Effect.flatMap(decodeDnsRecord),
      Effect.mapError(
        (cause) =>
          new ManagedEndpointDnsClientError({ operation: "get-record", dnsRecordId, cause }),
      ),
      Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
    );
  const listRecordsPage: ManagedEndpointDnsClient["Service"]["listRecordsPage"] = Effect.fnUntraced(
    function* (request) {
      return yield* Effect.gen(function* () {
        const hostname = yield* decodeExactHostname(request.hostname);
        if (
          !Number.isSafeInteger(request.page) ||
          request.page < 1 ||
          !Number.isSafeInteger(request.perPage) ||
          request.perPage < 1
        ) {
          return yield* new InvalidDnsResponse({ reason: "Invalid DNS page request" });
        }
        const response = yield* gate(
          dnsClient.listDnsRecords({
            name: { exact: hostname },
            page: request.page,
            perPage: request.perPage,
          }),
        ).pipe(Effect.timeout("8 seconds"));
        if (response.result.length > request.perPage) {
          return yield* new InvalidDnsResponse({ reason: "DNS page exceeds requested size" });
        }
        const records = yield* Effect.forEach(response.result, decodeDnsRecord);
        // Never hide a contradictory server response behind client-side filtering.
        if (records.some((record) => record.name !== hostname)) {
          return yield* new InvalidDnsResponse({
            reason: "Exact DNS query returned a different hostname",
          });
        }
        return {
          records,
          ...(response.resultInfo === undefined ? {} : { resultInfo: response.resultInfo }),
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDnsClientError({
              operation: "list-records-page",
              hostname: request.hostname,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      );
    },
  );
  return ManagedEndpointDnsClient.of({
    getRecord,
    listRecordsPage,
    listExactRecords: Effect.fn("ManagedEndpointDnsClient.listExactRecords")((hostname) =>
      listExactDnsRecords(listRecordsPage, hostname),
    ),
    listRecords: Effect.fn("ManagedEndpointDnsClient.listRecords")((hostname) =>
      gate(dnsClient.listDnsRecords({ search: hostname })).pipe(
        Effect.timeout("8 seconds"),
        Effect.map((response) =>
          response.result.filter(
            (record): record is typeof record & { readonly id: string } =>
              typeof record.id === "string" &&
              normalizeHostname(record.name) === normalizeHostname(hostname),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDnsClientError({
              operation: "list-records",
              hostname,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    createRecord: Effect.fn("ManagedEndpointClient.createRecord")((request) =>
      gate(dnsClient.createDnsRecord(request).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.flatMap(decodeDnsRecord),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDnsClientError({
              operation: "create-record",
              hostname: request.name,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    updateRecord: Effect.fn("ManagedEndpointClient.updateRecord")((dnsRecordId, request) =>
      gate(dnsClient.updateDnsRecord(dnsRecordId, request).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.flatMap(decodeDnsRecord),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDnsClientError({
              operation: "update-record",
              hostname: request.name,
              dnsRecordId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
    deleteRecord: Effect.fn("ManagedEndpointClient.deleteRecord")((dnsRecordId) =>
      gate(dnsClient.deleteDnsRecord(dnsRecordId).pipe(Retry.none)).pipe(
        Retry.none,
        Effect.timeout("8 seconds"),
        Effect.mapError(
          (cause) =>
            new ManagedEndpointDnsClientError({
              operation: "delete-record",
              dnsRecordId,
              cause,
            }),
        ),
        Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
      ),
    ),
  });
};

export const layerCloudflareBindings = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) => {
  const cloudflare = makeCloudflareApiGate(alchemyRuntimeContext);
  return layer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const gate = cloudflare(yield* CloudflareApiPause.CloudflareApiPause);
          return Layer.mergeAll(
            layerTunnelClient(
              makeCloudflareTunnelClient(tunnelClient, alchemyRuntimeContext, gate),
            ),
            layerDnsClient(makeCloudflareDnsClient(dnsClient, alchemyRuntimeContext, gate)),
          );
        }),
      ),
    ),
  );
};
