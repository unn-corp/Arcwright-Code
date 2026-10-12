/** Admission for persisted Connect state. Legacy restore is deliberately permissive. */
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  cloudCliOAuthConfig,
  relayUrlConfig,
  makeEffectiveConnectProfileConfig,
  type CloudCliOAuthConfig,
} from "./publicConfig.ts";

export const CliPublicAuthority = Schema.Struct({
  version: Schema.Literal(1),
  issuer: Schema.String,
  tokenEndpointOrigin: Schema.String,
  clientId: Schema.String,
});
export type CliPublicAuthority = typeof CliPublicAuthority.Type;
export const LinkPublicAuthority = Schema.Struct({
  version: Schema.Literal(1),
  relayOrigin: Schema.String,
  cli: CliPublicAuthority,
});
export type LinkPublicAuthority = typeof LinkPublicAuthority.Type;
export type SelectedConnectAuthority =
  | { readonly mode: "legacy"; readonly cli?: CliPublicAuthority; readonly relayOrigin?: string }
  | { readonly mode: "cloudless" }
  | { readonly mode: "unavailable" }
  | { readonly mode: "owned"; readonly relayOrigin: string; readonly cli: CliPublicAuthority };
export type ConnectAuthorityStatus = "active" | "cloudless" | "incompatible" | "unavailable";

export const authorityMessage = (status: ConnectAuthorityStatus): string | null =>
  status === "active"
    ? null
    : status === "cloudless"
      ? "Arcwright Connect is disabled in cloudless mode. Direct connections remain available."
      : status === "unavailable"
        ? "The selected Arcwright Connect public profile is unavailable."
        : "This Connect link belongs to another account service; unlink and reconnect.";

/** Stamp only at a successful exchange using the metadata that actually handled it. */
export function cliAuthorityFromMetadata(
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint" | "clientId">,
): CliPublicAuthority {
  const origin = new URL(metadata.tokenEndpoint).origin;
  return { version: 1, issuer: origin, tokenEndpointOrigin: origin, clientId: metadata.clientId };
}

export const selectedConnectAuthority: Effect.Effect<SelectedConnectAuthority> =
  makeEffectiveConnectProfileConfig().pipe(
    Effect.flatMap((profile): Effect.Effect<SelectedConnectAuthority> => {
      if (profile.mode === "legacy")
        return Effect.all([
          cloudCliOAuthConfig.pipe(Effect.option),
          relayUrlConfig.pipe(Effect.option),
        ]).pipe(
          Effect.map(([metadata, relay]): SelectedConnectAuthority => ({
            mode: "legacy",
            ...(Option.isSome(metadata) ? { cli: cliAuthorityFromMetadata(metadata.value) } : {}),
            ...(Option.isSome(relay) ? { relayOrigin: relay.value } : {}),
          })),
        );
      if (profile.mode === "cloudless") return Effect.succeed({ mode: "cloudless" });
      const issuer = new URL(
        clerkFrontendApiUrlFromPublishableKey(profile.T3CODE_CLERK_PUBLISHABLE_KEY),
      ).origin;
      return Effect.succeed({
        mode: "owned",
        relayOrigin: profile.T3CODE_RELAY_URL,
        cli: {
          version: 1,
          issuer,
          tokenEndpointOrigin: issuer,
          clientId: profile.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
        },
      });
    }),
    Effect.orElseSucceed((): SelectedConnectAuthority => ({ mode: "unavailable" })),
  );

export function admitsCliCredential(
  selected: SelectedConnectAuthority,
  stamp: CliPublicAuthority | undefined,
): boolean {
  if (selected.mode === "legacy" && stamp === undefined) return true;
  return (
    (selected.mode === "owned" || selected.mode === "legacy") &&
    selected.cli !== undefined &&
    stamp?.version === 1 &&
    normalizeSecureRelayUrl(stamp.issuer) === selected.cli.issuer &&
    normalizeSecureRelayUrl(stamp.tokenEndpointOrigin) === selected.cli.tokenEndpointOrigin &&
    stamp.clientId === selected.cli.clientId
  );
}

/** Missing relay issuer has always meant the saved relay URL, never the new selected URL. */
export function classifyRelayAuthority(
  selected: SelectedConnectAuthority,
  saved: {
    readonly relayUrl: string | null;
    readonly relayIssuer?: string | null | undefined;
    readonly publicAuthority?: LinkPublicAuthority | undefined;
  },
): ConnectAuthorityStatus {
  if (selected.mode === "cloudless" || selected.mode === "unavailable") return selected.mode;
  if (
    saved.publicAuthority !== undefined &&
    (!admitsCliCredential(selected, saved.publicAuthority.cli) ||
      saved.publicAuthority.relayOrigin !== selected.relayOrigin)
  )
    return "incompatible";
  if (selected.mode === "legacy" && saved.publicAuthority === undefined) return "active";
  return normalizeSecureRelayUrl(saved.relayUrl ?? "") === selected.relayOrigin &&
    normalizeSecureRelayUrl(saved.relayIssuer ?? saved.relayUrl ?? "") === selected.relayOrigin
    ? "active"
    : "incompatible";
}
