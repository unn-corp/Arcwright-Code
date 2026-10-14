import { createClerkClient, verifyToken } from "@clerk/backend";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { isBoundedJwt } from "../http/publicRelayInputBounds.ts";

import * as RelayConfiguration from "../Config.ts";

class ClerkTokenVerificationFailed extends Schema.TaggedError<ClerkTokenVerificationFailed>()(
  "ClerkTokenVerificationFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Clerk token verification failed";
  }
}

export function hasExpectedClerkAudience(audience: unknown, expectedAudience: string): boolean {
  return typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) &&
        audience.length <= 16 &&
        audience.some(
          (entry) =>
            typeof entry === "string" && entry.length <= 4096 && entry === expectedAudience,
        );
}

function verifyClerkBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  if (!isBoundedJwt(token, 16384))
    return Effect.fail(invalidClerkCredential("invalid_session_token"));
  return Effect.tryPromise({
    try: () =>
      verifyToken(token, {
        secretKey: Redacted.value(config.clerkSecretKey),
        audience: config.clerkJwtAudience,
      }),
    catch: (cause) => new ClerkTokenVerificationFailed({ cause }),
  }).pipe(
    Effect.withSpan("verify_clerk_bearer_token", {
      attributes: { "relay.auth.token_length": token.length },
    }),
  );
}

function isClerkUserSubject(subject: unknown): subject is string {
  return (
    typeof subject === "string" && subject.length <= 191 && /^user_[A-Za-z0-9]+$/.test(subject)
  );
}

function isOAuthGrantRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionJwt(token: string): boolean {
  const parts = token.split(".");
  const encodedHeader = parts[0];
  if (
    !encodedHeader ||
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return false;
  }
  try {
    const header: unknown = JSON.parse(atob(encodedHeader.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof header === "object" && header !== null && "typ" in header && header.typ === "JWT";
  } catch {
    return false;
  }
}

const invalidClerkCredential = (reason: string) =>
  new ClerkTokenVerificationFailed({ cause: { reason } });

/** Shared by bearer admission and the SESSION-only DPoP exchange. */
export function verifyRelaySessionBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  if (token.length > 16384 || new TextEncoder().encode(token).byteLength > 16384)
    return Effect.fail(invalidClerkCredential("invalid_token_length"));
  return RelayConfiguration.resolveClerkAuthPolicy(config).pipe(
    Effect.mapError(() => invalidClerkCredential("invalid_auth_policy")),
    Effect.flatMap((policy) => {
      if (policy.mode === "legacy") {
        return verifyClerkBearerToken(config, token);
      }
      return verifyOwnedClerkSessionBearerToken(config, policy, token);
    }),
  );
}

function verifyOwnedClerkSessionBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  policy: Extract<RelayConfiguration.ClerkAuthPolicy, { mode: "owned" }>,
  token: string,
) {
  if (!isBoundedJwt(token, 16384) || !isSessionJwt(token)) {
    return Effect.fail(invalidClerkCredential("invalid_session_kind"));
  }
  return Effect.tryPromise({
    try: () =>
      verifyToken(token, {
        secretKey: Redacted.value(config.clerkSecretKey),
        audience: config.clerkJwtAudience,
        headerType: "JWT",
      }),
    catch: () => invalidClerkCredential("session_verification_failed"),
  }).pipe(
    Effect.flatMap((verified) =>
      verified.iss === policy.issuer &&
      isClerkUserSubject(verified.sub) &&
      (typeof verified.aud === "string" ||
        (Array.isArray(verified.aud) &&
          verified.aud.length > 0 &&
          verified.aud.every((audience) => typeof audience === "string" && audience.length > 0))) &&
      hasExpectedClerkAudience(verified.aud, config.clerkJwtAudience)
        ? Effect.succeed(verified)
        : Effect.fail(invalidClerkCredential("invalid_session_claims")),
    ),
  );
}

function verifyOwnedClerkOAuthBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  policy: Extract<RelayConfiguration.ClerkAuthPolicy, { mode: "owned" }>,
  token: string,
) {
  return Effect.tryPromise({
    try: () =>
      createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      }).idPOAuthAccessToken.verify(token),
    catch: () => invalidClerkCredential("oauth_verification_failed"),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        const verified: unknown = response;
        if (!isOAuthGrantRecord(verified)) {
          return yield* invalidClerkCredential("invalid_oauth_response");
        }
        const { clientId, subject, scopes, revoked, expired, expiration } = verified;
        const now = yield* DateTime.now;
        // Direct BAPI fromJSON has no type field and preserves Unix SECONDS.
        // Bound timestamps to RFC 3339's four-digit years; never guess units.
        if (
          clientId !== policy.cliClientId ||
          !isClerkUserSubject(subject) ||
          (typeof subject === "string" && subject.length > 191) ||
          !Array.isArray(scopes) ||
          scopes.length > 64 ||
          !scopes.every(
            (scope) => typeof scope === "string" && scope.length > 0 && scope.length <= 256,
          ) ||
          !["openid", "profile", "email"].every((scope) => scopes.includes(scope)) ||
          revoked !== false ||
          expired !== false ||
          typeof expiration !== "number" ||
          !Number.isSafeInteger(expiration) ||
          expiration > 253_402_300_799 ||
          expiration <= Math.floor(now.epochMilliseconds / 1_000)
        ) {
          return yield* invalidClerkCredential("invalid_oauth_grant");
        }
        return { sub: subject, mode: "clerk_oauth_bearer" as const };
      }),
    ),
  );
}

function verifyClerkOAuthBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const client = createClerkClient({
        secretKey: Redacted.value(config.clerkSecretKey),
        publishableKey: config.clerkPublishableKey,
      });
      const state = await client.authenticateRequest(
        new Request(config.relayIssuer, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { acceptsToken: "oauth_token" },
      );
      const auth = state.toAuth();
      if (!state.isAuthenticated || !auth.userId || auth.userId.length > 191) {
        throw new Error("Clerk OAuth token is not authenticated.");
      }
      return { sub: auth.userId };
    },
    catch: (cause) => new ClerkTokenVerificationFailed({ cause }),
  });
}

export function verifyRelayClientBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  if (token.length > 16384 || new TextEncoder().encode(token).byteLength > 16384)
    return Effect.fail(invalidClerkCredential("invalid_token_length"));
  return RelayConfiguration.resolveClerkAuthPolicy(config).pipe(
    Effect.mapError(() => invalidClerkCredential("invalid_auth_policy")),
    Effect.flatMap((policy) =>
      policy.mode === "owned"
        ? token.startsWith("oat_")
          ? verifyOwnedClerkOAuthBearerToken(config, policy, token)
          : verifyOwnedClerkSessionBearerToken(config, policy, token).pipe(
              Effect.map((verified) => ({
                sub: verified.sub,
                mode: "clerk_session_bearer" as const,
              })),
            )
        : verifyLegacyRelayClientBearerToken(config, token),
    ),
  );
}

function verifyLegacyRelayClientBearerToken(
  config: RelayConfiguration.RelayConfiguration["Service"],
  token: string,
) {
  return verifyClerkBearerToken(config, token).pipe(
    Effect.flatMap((verified) =>
      verified.sub &&
      verified.sub.length <= 191 &&
      hasExpectedClerkAudience(verified.aud, config.clerkJwtAudience)
        ? Effect.succeed({ sub: verified.sub, mode: "clerk_session_bearer" as const })
        : Effect.fail(new ClerkTokenVerificationFailed({ cause: "missing_relay_audience" })),
    ),
    Effect.catch(() =>
      verifyClerkOAuthBearerToken(config, token).pipe(
        Effect.map((verified) => ({ ...verified, mode: "clerk_oauth_bearer" as const })),
      ),
    ),
  );
}
