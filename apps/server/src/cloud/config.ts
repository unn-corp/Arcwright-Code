import {
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  LinkPublicAuthority,
  classifyRelayAuthority,
  selectedConnectAuthority,
  type SelectedConnectAuthority,
} from "./connectAuthority.ts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const CLOUD_PUBLIC_AUTHORITY_SECRET = "cloud-public-authority";
/** Noncredential local intent: an explicit disconnect must survive failed cleanup and restart. */
export const CLOUD_LOCAL_DISABLED_SECRET = "cloud-local-disabled";
export const CLOUD_MINT_PUBLIC_KEY = "cloud-mint-ed25519-public-key";
export const CLOUD_ENDPOINT_RUNTIME_CONFIG = "cloud-endpoint-runtime-config";
export const CLOUD_ENDPOINT_CONFIRMED_ORIGIN = "cloud-endpoint-confirmed-origin";
export const CLOUD_LINKED_USER_ID = "cloud-linked-user-id";
export const RELAY_URL_SECRET = "cloud-relay-url";
export const RELAY_ISSUER_SECRET = "cloud-relay-issuer";
export const RELAY_ENVIRONMENT_CREDENTIAL_SECRET = "cloud-relay-environment-credential";
export const PUBLISH_AGENT_ACTIVITY_SECRET = "cloud-publish-agent-activity";
export const HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET = "cloud-hold-webhooks-while-offline";
export const CLOUD_LINK_REVOKED = "cloud-link-revoked";

/** Raw saved presence includes partial records; it is never an enrollment invitation. */
export const readPersistedCloudLinkPresent = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  options?: { readonly ignoreLocalDisabled?: boolean },
) =>
  Effect.forEach(
    [
      RELAY_URL_SECRET,
      RELAY_ISSUER_SECRET,
      CLOUD_PUBLIC_AUTHORITY_SECRET,
      ...(options?.ignoreLocalDisabled ? [] : [CLOUD_LOCAL_DISABLED_SECRET]),
      CLOUD_LINKED_USER_ID,
      CLOUD_ENDPOINT_RUNTIME_CONFIG,
      CLOUD_MINT_PUBLIC_KEY,
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    ],
    (name) => secrets.get(name),
  ).pipe(Effect.map((records) => records.some(Option.isSome)));

const decodeLinkPublicAuthority = Schema.decodeUnknownOption(
  Schema.fromJsonString(LinkPublicAuthority),
);

/** Fail closed without removing the saved record or implying it needs automatic enrollment. */
export const readPersistedRelayAuthorityStatus = Effect.fn(
  "config.readPersistedRelayAuthorityStatus",
)(
  function* (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    selected?: SelectedConnectAuthority,
    options?: { readonly ignoreLocalDisabled?: boolean },
  ) {
    const authority = selected ?? (yield* selectedConnectAuthority);
    if (
      !options?.ignoreLocalDisabled &&
      Option.isSome(yield* secrets.get(CLOUD_LOCAL_DISABLED_SECRET))
    )
      return "locally-disabled";
    if (authority.mode === "cloudless" || authority.mode === "unavailable") return authority.mode;
    const stamp = yield* secrets.get(CLOUD_PUBLIC_AUTHORITY_SECRET);
    const publicAuthority = Option.isSome(stamp)
      ? decodeLinkPublicAuthority(new TextDecoder().decode(stamp.value))
      : Option.none();
    if (Option.isSome(stamp) && Option.isNone(publicAuthority)) return "unavailable";
    if (authority.mode === "legacy" && Option.isNone(stamp)) return "active";
    if (authority.mode === "owned") {
      const credentials = yield* Effect.all([
        secrets.get(CLOUD_LINKED_USER_ID),
        secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      ]);
      if (credentials.some((value) => Option.isNone(value) || value.value.length === 0))
        return "incompatible";
    }
    const [url, issuer] = yield* Effect.all([
      secrets.get(RELAY_URL_SECRET),
      secrets.get(RELAY_ISSUER_SECRET),
    ]);
    return classifyRelayAuthority(authority, {
      ...(Option.isSome(publicAuthority) ? { publicAuthority: publicAuthority.value } : {}),
      relayUrl: Option.isSome(url) ? new TextDecoder().decode(url.value) : null,
      relayIssuer: Option.isSome(issuer) ? new TextDecoder().decode(issuer.value) : null,
    });
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => "unavailable" as const)),
);

export const encodeEndpointRuntimeConfigJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const decodeRuntimeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const ManagedEndpointConfirmedOrigin = Schema.Struct({
  config: RelayManagedEndpointRuntimeConfig,
  origin: RelayManagedEndpointOrigin,
});

export const encodeConfirmedOriginJson = Schema.encodeEffect(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

export const decodeConfirmedOrigin = Schema.decodeUnknownOption(
  Schema.fromJsonString(ManagedEndpointConfirmedOrigin),
);

export function isAgentActivityPublishingEnabledValue(value: string | null): boolean {
  return value === "true";
}

/**
 * Mirrors the per-publish gate in AgentAwarenessRelay, so the descriptor
    capability never advertises publishing that the publisher would skip.
 */
export const readAgentActivityPublishingActive: (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) => Effect.Effect<boolean> = Effect.fn("config.readAgentActivityPublishingActive")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    if ((yield* readPersistedRelayAuthorityStatus(secrets)) !== "active") return false;
    const readSecretString = (name: string) =>
      secrets
        .get(name)
        .pipe(
          Effect.map((bytes) =>
            Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
          ),
        );
    const [enabled, url, environmentCredential] = yield* Effect.all([
      readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET),
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    // Match the publisher, which treats empty strings as unconfigured.
    return (
      isAgentActivityPublishingEnabledValue(enabled) &&
      url !== null &&
      url !== "" &&
      environmentCredential !== null &&
      environmentCredential !== ""
    );
  },
  Effect.orElseSucceed(() => false),
);

const readSecretString = (name: string) =>
  ServerSecretStore.ServerSecretStore.pipe(
    Effect.flatMap((secrets) => secrets.get(name)),
    Effect.map((bytes) =>
      Option.isSome(bytes) && bytes.value.length > 0 ? new TextDecoder().decode(bytes.value) : null,
    ),
    Effect.orElseSucceed(() => null),
  );

/** The relay URL and environment credential, or null when not linked to Arcwright Connect. */
export const readRelayConnection = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if ((yield* readPersistedRelayAuthorityStatus(secrets)) !== "active") return null;
  return yield* Effect.all([
    readSecretString(RELAY_URL_SECRET),
    readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
  ]).pipe(
    Effect.map(([url, environmentCredential]) =>
      url && environmentCredential ? { url, environmentCredential } : null,
    ),
  );
});

/** Whether this environment opted in to Arcwright Connect holding webhooks while it is offline. */
export const readHoldWebhooksWhileOffline = readSecretString(
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
).pipe(Effect.map((value) => value === "true"));
