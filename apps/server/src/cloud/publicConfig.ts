import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { isRelayTracingEnabled } from "@t3tools/shared/otelEnvironment";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import {
  CONNECT_PUBLIC_KEYS,
  CONNECT_PUBLIC_ALIASES,
  effectiveConnectProfile,
  resolveConnectMode,
  selectConnectProfile,
  type ConnectProfileReceipt,
  type ConnectPublicKey,
} from "@t3tools/shared/connectProfile";
import * as Option from "effect/Option";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_CONNECT_MODE__: string | undefined;
declare const __T3CODE_BUILD_HOSTED_APP_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_JWT_TEMPLATE__: string | undefined;
declare const __T3CODE_BUILD_CONNECT_PROFILE_DIGEST__: string | undefined;
declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
const buildConnectMode = resolveConnectMode(
  typeof __T3CODE_BUILD_CONNECT_MODE__ === "undefined" ? undefined : __T3CODE_BUILD_CONNECT_MODE__,
);

const buildConnectProfile = selectConnectProfile(buildConnectMode, [
  {
    T3CODE_CLERK_PUBLISHABLE_KEY: buildTimeClerkPublishableKey,
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: buildTimeClerkCliOAuthClientId,
    T3CODE_CLERK_JWT_TEMPLATE:
      typeof __T3CODE_BUILD_CLERK_JWT_TEMPLATE__ === "undefined"
        ? ""
        : __T3CODE_BUILD_CLERK_JWT_TEMPLATE__,
    T3CODE_RELAY_URL: buildTimeRelayUrl,
    T3CODE_HOSTED_APP_URL:
      typeof __T3CODE_BUILD_HOSTED_APP_URL__ === "undefined" ? "" : __T3CODE_BUILD_HOSTED_APP_URL__,
  },
]);

/** Every owned consumer resolves the same complete runtime source or complete compiled profile. */
export function makeEffectiveConnectProfileConfig(build = buildConnectProfile) {
  const names = [
    "T3CODE_CONNECT_MODE",
    ...CONNECT_PUBLIC_KEYS.flatMap((key) => [key, ...CONNECT_PUBLIC_ALIASES[key]]),
  ];
  return Config.all(
    Object.fromEntries(names.map((name) => [name, Config.String(name).pipe(Config.option)])),
  ).pipe(
    Config.mapEffect((values) =>
      Effect.try({
        try: () =>
          effectiveConnectProfile(
            build,
            Object.fromEntries(
              Object.entries(values).map(([name, value]) => [name, Option.getOrUndefined(value)]),
            ),
          ),
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "Invalid effective Connect public profile; require a complete coherent owned source and the selected build mode.",
            }),
          ),
      }),
    ),
  );
}

function modeAwarePublicValue(
  key: ConnectPublicKey,
  legacy: Config.Config<string>,
  build = buildConnectProfile,
) {
  return makeEffectiveConnectProfileConfig(build).pipe(
    Config.flatMap((profile) =>
      profile.mode === "legacy"
        ? legacy
        : Config.succeed(profile[key]).pipe(
            Config.mapEffect((value) =>
              value
                ? Effect.succeed(value)
                : Effect.fail(
                    new Config.ConfigError(
                      new ConfigProvider.SourceError({
                        message: "Connect is disabled in cloudless mode.",
                      }),
                    ),
                  ),
            ),
          ),
    ),
  );
}

const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  if (!isRelayTracingEnabled(env)) {
    return null;
  }

  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl, build = buildConnectProfile) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return modeAwarePublicValue(
    "T3CODE_RELAY_URL",
    fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig,
    build,
  ).pipe(Config.mapEffect(validateRelayUrl));
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export function makeHostedAppUrlConfig(
  fallback = buildConnectProfile.T3CODE_HOSTED_APP_URL || DEFAULT_HOSTED_APP_URL,
  build = buildConnectProfile,
) {
  return modeAwarePublicValue(
    "T3CODE_HOSTED_APP_URL",
    makePublicValueConfig("T3CODE_HOSTED_APP_URL", fallback),
    build,
  ).pipe(Config.mapEffect(validateHostedAppUrl));
}
export const hostedAppUrlConfig = makeHostedAppUrlConfig();

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
  connectProfileFallback = buildConnectProfile,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
  readonly connectProfileFallback?: ConnectProfileReceipt;
} = {}) {
  return Config.all({
    clerkPublishableKey: modeAwarePublicValue(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      makePublicValueConfig("T3CODE_CLERK_PUBLISHABLE_KEY", clerkPublishableKeyFallback),
      connectProfileFallback,
    ),
    clientId: modeAwarePublicValue(
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      makePublicValueConfig("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", clerkCliOAuthClientIdFallback),
      connectProfileFallback,
    ),
  }).pipe(
    Config.mapEffect(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              deviceAuthorizationEndpoint: `${clerkFrontendApiUrl}/oauth/device_authorization`,
              clientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = (() => {
  try {
    const profile = effectiveConnectProfile(buildConnectProfile, process.env);
    if (profile.mode !== "legacy") return profile.mode === "owned";
    return Boolean(
      (normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
      (process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
      (process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId),
    );
  } catch {
    return false;
  }
})();
