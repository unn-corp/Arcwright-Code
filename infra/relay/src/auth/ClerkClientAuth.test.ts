// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture JWT signatures use Node crypto.
import * as NodeCrypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import type { RelayConfiguration } from "../Config.ts";
import { verifyRelayClientBearerToken, verifyRelaySessionBearerToken } from "./ClerkClientAuth.ts";

vi.mock("@clerk/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/backend")>();
  return { ...actual, createClerkClient: vi.fn(actual.createClerkClient), verifyToken: vi.fn() };
});

const issuer = "https://clerk.arcwright.space";
const clientId = "VS3HcN01wPJotPrs";
const now = 1_800_000_000;
const ownedSettings: RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.arcwright.space",
  apns: null,
  clerkSecretKey: Redacted.make("sk_live_fixture"),
  clerkPublishableKey: "pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA",
  clerkJwtAudience: "t3-code-relay",
  clerkAuthPolicy: { mode: "owned", issuer, cliClientId: clientId },
  apnsDeliveryJobSigningSecret: Redacted.make("fixture"),
  cloudMintPrivateKey: Redacted.make("fixture"),
  cloudMintPublicKey: "fixture",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const opaqueJson = {
  object: "clerk_idp_oauth_access_token",
  id: "fixture-access-id",
  client_id: clientId,
  subject: "user_newSignupA",
  scopes: ["email", "openid", "profile", "offline_access"],
  revoked: false,
  revocation_reason: null,
  expired: false,
  expiration: now + 3600,
  created_at: now,
  updated_at: now,
};
const sessionClaims = { sub: "user_newSignupA", iss: issuer, aud: "t3-code-relay" };
const jwt = (header: unknown = { typ: "JWT" }) =>
  `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.c2lnbmF0dXJl`;
const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(createClerkClient).mockClear();
  vi.mocked(verifyToken).mockReset();
  fetchMock.mockReset();
});

const respond = (body: unknown, status = 200) => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
};

describe("owned Clerk bearer policy", () => {
  it.effect.each([
    { name: "204 empty", body: undefined, status: 204 },
    { name: "null", body: null, status: 200 },
    { name: "array", body: [], status: 200 },
    { name: "string", body: "provider-message-fixture", status: 200 },
    { name: "missing grant fields", body: {}, status: 200 },
  ])("maps real SDK $name responses to a controlled local auth failure", ({ body, status }) =>
    Effect.gen(function* () {
      respond(body, status);
      const error = yield* Effect.flip(
        verifyRelayClientBearerToken(ownedSettings, "oat_sensitive_fixture"),
      );
      expect(error._tag).toBe("ClerkTokenVerificationFailed");
      expect(error.cause).toEqual({
        reason: expect.stringMatching(
          /^(invalid_oauth_response|invalid_oauth_grant|oauth_verification_failed)$/,
        ),
      });
      // The SDK reads the audience before returning the grant, so an empty
      // response rejects inside the SDK instead of reaching local validation.
      if (status === 204) expect(error.cause).toEqual({ reason: "oauth_verification_failed" });
      expect(JSON.stringify(error.cause)).not.toContain("oat_sensitive_fixture");
      expect(JSON.stringify(error.cause)).not.toContain("provider-message-fixture");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "uses the real public SDK direct verifier and seconds/no-type response for two ordinary users",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now * 1000);
        for (const subject of ["user_newSignupA", "user_newSignupB"]) {
          respond({
            ...opaqueJson,
            subject,
            scopes: ["profile", "harmless_extra", "email", "openid"],
          });
          const token = `oat_fixture_${subject}`;
          expect(yield* verifyRelayClientBearerToken(ownedSettings, token)).toEqual({
            sub: subject,
            mode: "clerk_oauth_bearer",
          });
          expect(fetchMock).toHaveBeenLastCalledWith(
            "https://api.clerk.com/oauth_applications/access_tokens/verify",
            expect.objectContaining({
              method: "POST",
              body: JSON.stringify({ access_token: token }),
            }),
          );
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(verifyToken).not.toHaveBeenCalled();
        expect(createClerkClient).toHaveBeenCalledWith({
          secretKey: "sk_live_fixture",
          publishableKey: ownedSettings.clerkPublishableKey,
        });
      }),
  );

  it.effect.each([
    ["wrong client", { client_id: "otherClient" }],
    ["missing client", { client_id: undefined }],
    ["resource id", { client_id: "oa_resourceId" }],
    ["missing required scope", { scopes: ["openid", "profile", "offline_access"] }],
    ["scope string", { scopes: "openid profile email" }],
    ["scope null", { scopes: null }],
    ["nonstrings", { scopes: ["openid", "profile", "email", 1] }],
    ["empty scope", { scopes: ["openid", "profile", "email", ""] }],
    ["empty subject", { subject: "user_" }],
    ["missing subject", { subject: undefined }],
    ["whitespace subject", { subject: "user_a b" }],
    ["organization", { subject: "org_fixture" }],
    ["machine", { subject: "mch_fixture" }],
    ["missing expiration", { expiration: undefined }],
    ["null expiration", { expiration: null }],
    ["nonfinite expiration", { expiration: Infinity }],
    ["fraction expiration", { expiration: now + 0.5 }],
    ["expired time", { expiration: now }],
    ["past time", { expiration: now - 1 }],
    ["milliseconds shape", { expiration: (now + 3600) * 1000 }],
    ["revoked", { revoked: true }],
    ["missing revoked", { revoked: undefined }],
    ["nonboolean revoked", { revoked: "false" }],
    ["expired", { expired: true }],
    ["missing expired", { expired: undefined }],
  ] as const)("rejects authoritative opaque metadata: %s", ([_name, changes]) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now * 1000);
      respond({ ...opaqueJson, ...changes });
      expect(
        (yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, "oat_fixture")))._tag,
      ).toBe("ClerkTokenVerificationFailed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([404, 503])("fails closed for BAPI status %s without fallback", (status) =>
    Effect.gen(function* () {
      respond(
        { errors: [{ code: "oauth_access_token_not_found", message: "fixture rejection" }] },
        status,
      );
      expect(
        (yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, "oat_fixture")))._tag,
      ).toBe("ClerkTokenVerificationFailed");
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails closed for unavailable network", () =>
    Effect.gen(function* () {
      fetchMock.mockRejectedValue(new Error("offline fixture"));
      vi.stubGlobal("fetch", fetchMock);
      expect(
        (yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, "oat_fixture")))._tag,
      ).toBe("ClerkTokenVerificationFailed");
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["user_newSignupA", "user_newSignupB"])(
    "preserves native template JWT for %s without sid/client/scopes",
    (sub) =>
      Effect.gen(function* () {
        vi.mocked(verifyToken).mockResolvedValue({ ...sessionClaims, sub } as never);
        expect(yield* verifyRelayClientBearerToken(ownedSettings, jwt())).toEqual({
          sub,
          mode: "clerk_session_bearer",
        });
        expect(yield* verifyRelaySessionBearerToken(ownedSettings, jwt())).toEqual({
          ...sessionClaims,
          sub,
        });
        expect(verifyToken).toHaveBeenCalledWith(jwt(), {
          secretKey: "sk_live_fixture",
          audience: "t3-code-relay",
          headerType: "JWT",
        });
        expect(createClerkClient).not.toHaveBeenCalled();
      }),
  );

  it.effect.each([
    ["missing issuer", { iss: undefined }],
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["issuer slash", { iss: `${issuer}/` }],
    ["missing audience", { aud: undefined }],
    ["ID token audience", { aud: clientId }],
    ["mixed audience", { aud: ["t3-code-relay", 1] }],
    ["empty audience entry", { aud: ["t3-code-relay", ""] }],
    ["empty audience", { aud: [] }],
    ["object audience", { aud: { relay: "t3-code-relay" } }],
    ["missing subject", { sub: undefined }],
    ["org subject", { sub: "org_fixture" }],
    ["machine subject", { sub: "mch_fixture" }],
  ] as const)("rejects verified session claims: %s", ([_name, changes]) =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({ ...sessionClaims, ...changes } as never);
      yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, jwt()));
      yield* Effect.flip(verifyRelaySessionBearerToken(ownedSettings, jwt()));
      expect(createClerkClient).not.toHaveBeenCalled();
    }),
  );

  it.effect("accepts a fully string audience array containing the exact relay audience", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        ...sessionClaims,
        aud: ["other-audience", "t3-code-relay"],
      } as never);
      expect((yield* verifyRelayClientBearerToken(ownedSettings, jwt())).sub).toBe(
        sessionClaims.sub,
      );
    }),
  );

  it.effect.each([
    jwt({ typ: "at+jwt" }),
    jwt({ typ: "application/at+jwt" }),
    jwt({ typ: "dpop+jwt" }),
    jwt({}),
    "ak_fixture",
    "mt_fixture",
    "m2m_fixture",
    "ort_fixture",
    "refresh_fixture",
    "invalid",
    "oat_fixture.notjwt.signature",
  ])("rejects wrong credential kind %s without SDK fallback", (token) =>
    Effect.gen(function* () {
      // A permissive mock cannot turn the wrong kind into admission.
      vi.mocked(verifyToken).mockResolvedValue(sessionClaims as never);
      if (token.startsWith("oat_")) respond({ ...opaqueJson, client_id: "wrong" });
      yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, token));
      yield* Effect.flip(verifyRelaySessionBearerToken(ownedSettings, token));
      expect(verifyToken).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(token.startsWith("oat_") ? 1 : 0);
    }),
  );

  it.effect("never falls back from a failed session signature", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("bad signature"));
      yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, jwt()));
      expect(createClerkClient).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { mode: "unknown" },
    { mode: "owned" },
    { mode: "owned", issuer },
    { mode: "owned", issuer: "https://attacker.example/path", cliClientId: clientId },
    { mode: "legacy", issuer, cliClientId: clientId },
    null,
  ])("fails closed for injected invalid policy %j", (clerkAuthPolicy) =>
    Effect.gen(function* () {
      yield* Effect.flip(
        verifyRelayClientBearerToken({ ...ownedSettings, clerkAuthPolicy } as never, "oat_fixture"),
      );
      expect(createClerkClient).not.toHaveBeenCalled();
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { clerkPublishableKey: "pk_live_invalid" },
    { clerkPublishableKey: "pk_test_d3JvbmcuaW5zdGFuY2Uk" },
    { clerkJwtAudience: "" },
    { clerkJwtAudience: "wrong audience" },
  ])("rejects invalid owned key/audience configuration %j", (changes) =>
    Effect.gen(function* () {
      yield* Effect.flip(
        verifyRelayClientBearerToken({ ...ownedSettings, ...changes }, "oat_fixture"),
      );
      expect(createClerkClient).not.toHaveBeenCalled();
      expect(verifyToken).not.toHaveBeenCalled();
    }),
  );

  it.effect("checks expiration at admission after an upstream delay", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now * 1000);
      const started = yield* Deferred.make<void>();
      let finish: ((response: Response) => void) | undefined;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
            Deferred.doneUnsafe(started, Effect.void);
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const fiber = yield* verifyRelayClientBearerToken(ownedSettings, "oat_fixture").pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.seconds(3600));
      finish!(
        new Response(JSON.stringify(opaqueJson), {
          headers: { "content-type": "application/json" },
        }),
      );
      expect((yield* Effect.flip(Fiber.join(fiber)))._tag).toBe("ClerkTokenVerificationFailed");
    }),
  );

  it.effect("verifies a signed native fixture with the actual public session SDK", () =>
    Effect.gen(function* () {
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof import("@clerk/backend")>("@clerk/backend"),
      );
      vi.mocked(verifyToken).mockImplementation(actual.verifyToken);
      const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const kid = "owned-session-fixture";
      respond({
        keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }],
      });
      const epoch = Math.floor((yield* TestClock.withLive(Clock.currentTimeMillis)) / 1000);
      const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", kid })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({ ...sessionClaims, iat: epoch, nbf: epoch, exp: epoch + 60 }),
      ).toString("base64url");
      const unsigned = `${header}.${payload}`;
      const signed = `${unsigned}.${NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), keys.privateKey).toString("base64url")}`;
      expect((yield* verifyRelayClientBearerToken(ownedSettings, signed)).sub).toBe(
        sessionClaims.sub,
      );
      expect(createClerkClient).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith("https://api.clerk.com/v1/jwks", expect.anything());
      for (const times of [{ exp: epoch - 60 }, { nbf: epoch + 60 }]) {
        const invalidPayload = Buffer.from(
          JSON.stringify({ ...sessionClaims, iat: epoch, nbf: epoch, exp: epoch + 60, ...times }),
        ).toString("base64url");
        const invalidUnsigned = `${header}.${invalidPayload}`;
        const invalidSigned = `${invalidUnsigned}.${NodeCrypto.sign("RSA-SHA256", Buffer.from(invalidUnsigned), keys.privateKey).toString("base64url")}`;
        yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, invalidSigned));
      }
      const otherKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const invalidSignature = `${unsigned}.${NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), otherKey.privateKey).toString("base64url")}`;
      yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, invalidSignature));
      expect(createClerkClient).not.toHaveBeenCalled();
    }),
  );
});

it.effect.each([
  { name: "outer", token: "x".repeat(16385) },
  ...[["x".repeat(257)], [123]].map((crit, index) => ({
    name: `crit-${index}`,
    token: `${Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", crit })).toString("base64url")}.e30.c2ln`,
  })),
  {
    name: "header",
    token: `${Buffer.from(JSON.stringify({ typ: "JWT", padding: "x".repeat(2048) })).toString("base64url")}.e30.c2ln`,
  },
  {
    name: "depth",
    token: `${Buffer.from('{"typ":"JWT"}').toString("base64url")}.${Buffer.from("[".repeat(33) + "0" + "]".repeat(33)).toString("base64url")}.c2ln`,
  },
  {
    name: "keys",
    token: `${Buffer.from('{"typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 0])))).toString("base64url")}.c2ln`,
  },
  {
    name: "audience",
    token: `${Buffer.from('{"typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ aud: Array.from({ length: 17 }, () => "relay") })).toString("base64url")}.c2ln`,
  },
])("actual Clerk entry rejects bounded $name violations before SDK", ({ token }) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(verifyRelayClientBearerToken(ownedSettings, token));
    expect(error._tag).toBe("ClerkTokenVerificationFailed");
    expect(verifyToken).not.toHaveBeenCalled();
    expect(createClerkClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }),
);

it.effect("ordinary Clerk JWT header extensions do not inherit the DPoP public-key policy", () =>
  Effect.gen(function* () {
    vi.mocked(verifyToken).mockResolvedValue(sessionClaims as never);
    const token = jwt({
      typ: "JWT",
      alg: "RS256",
      jwk: { kty: "RSA", n: "bounded-public-modulus", e: "AQAB" },
      harmless_extension: { enabled: true },
    });
    expect(yield* verifyRelayClientBearerToken(ownedSettings, token)).toMatchObject({
      sub: sessionClaims.sub,
      mode: "clerk_session_bearer",
    });
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  }),
);
