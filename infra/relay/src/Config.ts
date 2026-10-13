import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
/** Separate switch for tunnels whose host never registered recovery. */
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

/**
 * Overrides the 7-day legacy grace period, in minutes, so the disposable
 * canary stage can exercise legacy cleanup. Ignored on the prod stage.
 */
const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

// A zero or negative override would be ignored at runtime, silently leaving
// the canary on the 7-day grace period, so reject it when the deploy reads it.
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

/** Missing mode is deliberately legacy; stray owned fields must never select that fallback. */
export const clerkAuthPolicyConfig = Config.all({
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
    /** Canary-only override of the legacy grace period; ignored on prod. */
    readonly legacyTunnelGraceMinutes?: number;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

/** Validate injected runtime services too, before accepting any credential. */
class InvalidClerkAuthPolicy extends Data.TaggedError("InvalidClerkAuthPolicy") {}

export const resolveClerkAuthPolicy = (configuration: RelayConfiguration["Service"]) =>
  Effect.gen(function* () {
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
