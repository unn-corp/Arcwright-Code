import {
  clerkFrontendApiHostnameFromPublishableKey,
  relayClerkTokenOptions,
} from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import {
  resolveConnectMode,
  selectConnectProfile,
  type ConnectMode,
} from "@t3tools/shared/connectProfile";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly connectMode: ConnectMode;
  readonly hostedAppUrl: string | null;
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  const mode = resolveConnectMode(import.meta.env.VITE_CONNECT_MODE);
  const profile =
    mode === "legacy"
      ? null
      : selectConnectProfile(mode, [
          {
            T3CODE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
            T3CODE_CLERK_JWT_TEMPLATE: import.meta.env.VITE_CLERK_JWT_TEMPLATE,
            T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID,
            T3CODE_RELAY_URL: import.meta.env.VITE_T3CODE_RELAY_URL,
            T3CODE_HOSTED_APP_URL: import.meta.env.VITE_CONNECT_HOSTED_APP_URL,
          },
        ]);
  return {
    connectMode: mode,
    hostedAppUrl: trimNonEmpty(
      profile?.T3CODE_HOSTED_APP_URL ?? import.meta.env.VITE_CONNECT_HOSTED_APP_URL,
    ),
    clerkPublishableKey: trimNonEmpty(
      profile?.T3CODE_CLERK_PUBLISHABLE_KEY ??
        (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined),
    ),
    clerkJwtTemplate: trimNonEmpty(
      profile?.T3CODE_CLERK_JWT_TEMPLATE ??
        (import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    ),
    relayUrl: normalizeSecureRelayUrl(
      profile?.T3CODE_RELAY_URL ??
        (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ??
        "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  // The relay exporter is created during module initialization, so this must be synchronous.
  if (typeof window !== "undefined" && window.desktopBridge?.getRelayTelemetryEnabled() === false) {
    return null;
  }
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.relayUrl) {
    return false;
  }

  // Electron and the bundled Android shell own native auth; development keys also
  // support private browser origins. Browser production keys stay domain-scoped.
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    import.meta.env.VITE_ANDROID_PWA === "1" ||
    !config.clerkPublishableKey.startsWith("pk_live_")
  ) {
    return true;
  }

  try {
    // Custom Frontend API hosts use clerk.<production domain>.
    const domain = clerkFrontendApiHostnameFromPublishableKey(config.clerkPublishableKey).replace(
      /^clerk\./u,
      "",
    );
    const { hostname, protocol, port } = window.location;
    return (
      protocol === "https:" &&
      port === "" &&
      (hostname === domain || hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
