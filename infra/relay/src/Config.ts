import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

export const ClerkAuthPolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("legacy") }),
  Schema.Struct({
    mode: Schema.Literal("owned"),
    issuer: Schema.String.pipe(Schema.check(Schema.makeFilter(isHttpsOrigin))),
    cliClientId: Schema.String.pipe(
      Schema.check(
        Schema.makeFilter((value) => /^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith("oa_")),
      ),
    ),
  }),
]);
export type ClerkAuthPolicy = typeof ClerkAuthPolicy.Type;
const decodeClerkAuthPolicy = Schema.decodeUnknownEffect(ClerkAuthPolicy, {
  onExcessProperty: "error",
});

const CLERK_AUTH_KEYS = [
  "RELAY_CLERK_AUTH_MODE",
  "RELAY_CLERK_ISSUER",
  "RELAY_CLERK_CLI_CLIENT_ID",
] as const;

/** Leaf reads stay inside Alchemy's interceptor so only real values are auto-bound. */
const clerkAuthPolicyFieldsConfig = Config.all({
  mode: Config.String("RELAY_CLERK_AUTH_MODE").pipe(Config.withDefault("legacy")),
  issuer: Config.option(Config.String("RELAY_CLERK_ISSUER")),
  cliClientId: Config.option(Config.String("RELAY_CLERK_CLI_CLIENT_ID")),
}).pipe(
  Config.mapEffect(({ mode, issuer, cliClientId }) =>
    decodeClerkAuthPolicy(
      mode === "legacy" && Option.isNone(issuer) && Option.isNone(cliClientId)
        ? { mode }
        : {
            mode,
            issuer: Option.getOrUndefined(issuer),
            cliClientId: Option.getOrUndefined(cliClientId),
          },
    ).pipe(Effect.mapError((error) => new Config.ConfigError(error))),
  ),
);

const invalidClerkAuthConfiguration = () =>
  Effect.fail(
    new Config.ConfigError(
      new Schema.SchemaError(new SchemaIssue.InvalidValue({ message: "invalid_auth_policy" })),
    ),
  );

/**
 * Default providers drop empty leaves but retain their original parent keys.
 * Run outside the Worker layer: Alchemy would otherwise auto-bind parent records.
 */
export const parseClerkAuthPolicyConfig = Effect.fn("Config.parseClerkAuthPolicyConfig")(function* (
  provider: ConfigProvider.ConfigProvider,
) {
  const root = yield* provider
    .load([])
    .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
  for (const key of CLERK_AUTH_KEYS) {
    const leaf = yield* provider
      .load([key])
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
    if (leaf !== undefined) continue;
    const segments = key.split("_");
    const last = segments.pop();
    const parent = yield* provider
      .load(segments)
      .pipe(Effect.mapError((error) => new Config.ConfigError(error)));
    if (
      (root?._tag === "Record" && root.keys.has(key)) ||
      (last !== undefined && parent?._tag === "Record" && parent.keys.has(last))
    ) {
      return yield* invalidClerkAuthConfiguration();
    }
  }
  return yield* clerkAuthPolicyFieldsConfig.parse(provider);
});

/** Deployment preflight must finish before building the Worker layer. */
export const clerkAuthPolicyConfig = Effect.gen(function* () {
  return yield* parseClerkAuthPolicyConfig(yield* ConfigProvider.ConfigProvider);
});

/** The bridge's raw environment retains own-property presence even for dropped empty bindings. */
export const clerkAuthPolicyFromWorkerEnvironment = Effect.fn(
  "Config.clerkAuthPolicyFromWorkerEnvironment",
)(function* (environment: Readonly<Record<string, unknown>>) {
  for (const key of CLERK_AUTH_KEYS) {
    if (
      Object.hasOwn(environment, key) &&
      (typeof environment[key] !== "string" || environment[key].trim().length === 0)
    ) {
      return yield* invalidClerkAuthConfiguration();
    }
  }
  // Plan-time WorkerEnvironment is {}, so it cannot replace operator preflight.
  // These leaf reads preserve Alchemy's existing binding and marker reification.
  return yield* clerkAuthPolicyFieldsConfig;
});

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    /** Omission preserves callers predating the explicit deployment policy. */
    readonly clerkAuthPolicy?: ClerkAuthPolicy;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly webPushDeliveryJobSigningSecret?: Redacted.Redacted<string>;
    readonly webPush?: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: Redacted.Redacted<string>;
    };
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyTunnelGraceMinutes?: number;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

/** Validate injected runtime services too, before accepting any credential. */
class InvalidClerkAuthPolicy extends Data.TaggedError("InvalidClerkAuthPolicy") {}

export const resolveClerkAuthPolicy = Effect.fn("Config.resolveClerkAuthPolicy")(function* (
  configuration: RelayConfiguration["Service"],
) {
  const policy = yield* decodeClerkAuthPolicy(
    configuration.clerkAuthPolicy === undefined
      ? { mode: "legacy" }
      : configuration.clerkAuthPolicy,
  );
  if (policy.mode === "legacy") {
    const supplied = configuration.clerkAuthPolicy;
    if (supplied && ("issuer" in supplied || "cliClientId" in supplied)) {
      return yield* new InvalidClerkAuthPolicy();
    }
  } else {
    let frontendApi = "";
    try {
      const encoded = configuration.clerkPublishableKey.match(
        /^pk_(?:live|test)_([A-Za-z0-9+/=]+)$/,
      )?.[1];
      frontendApi = encoded ? atob(encoded) : "";
    } catch {
      return yield* new InvalidClerkAuthPolicy();
    }
    if (
      frontendApi !== `${new URL(policy.issuer).host}$` ||
      !/^[A-Za-z0-9_-]+$/.test(configuration.clerkJwtAudience)
    ) {
      return yield* new InvalidClerkAuthPolicy();
    }
  }
  return policy;
});

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
