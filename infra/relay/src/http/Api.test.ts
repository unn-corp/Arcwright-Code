import * as PublicLimits from "./PublicRelayRateLimits.ts";
import * as HttpServer from "effect/http/HttpServer";
import {
  RelayClientAuth,
  RelayDpopClientAuth,
  RelayClientPrincipal,
  type RelayClientDeviceRecord,
} from "@t3tools/contracts/relay";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as WebPushSubscriptions from "../agentActivity/WebPushSubscriptions.ts";
import * as WebPushDeliveryQueue from "../agentActivity/WebPushDeliveryQueue.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import { createClerkClient, verifyToken } from "@clerk/backend";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Etag from "effect/http/Etag";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";

import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
  RelayApi,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkRequest,
} from "@t3tools/contracts/relay";
import { relayProtectedErrorMessage } from "@t3tools/client-runtime/relay";
import { RELAY_MANAGED_TUNNEL_RECOVERY_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";

import {
  RELAY_HTTP_ROUTER_CONFIG,
  RELAY_REQUEST_DEADLINE_MS,
  recoverEnvironmentTunnelRecord,
  registerEnvironmentTunnelRecovery,
  relayDpopFailureReason,
  traceRelayHttpRequestWith,
  unlinkEnvironmentRecord,
  verifyRelayClientBearerToken,
  verifyEnvironmentTunnelRecoveryProof,
  withoutCapturedRequestContext,
} from "./Api.ts";
import * as RelayHttpApi from "./Api.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointLifecycle from "../environments/ManagedEndpointLifecycle.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const layerTestLimiter = Layer.succeed(PublicLimits.PublicRelayRateLimits, {
  admit: () => Effect.void,
});
const verifiedFixtureProof = {
  thumbprint: "fixture-thumbprint",
  jti: "fixture",
  iat: 0,
  expiresAt: DateTime.makeUnsafe(300_000),
};

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const encodeLinkRequest = Schema.encodeEffect(Schema.fromJsonString(RelayEnvironmentLinkRequest));
const decodeLinkUnavailableError = Schema.decodeUnknownEffect(RelayEnvironmentLinkUnavailableError);

describe("managed endpoint provisioning errors", () => {
  it.effect("returns the failed stage without exposing provider secrets through HTTP", () => {
    let traceId = "";
    const handlers = RelayHttpApi.layerClientApi.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(RelayDb.RelayTransactions, {}),
          Layer.mock(HookInbox.HookInbox, {}),
          Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
          NodeCryptoLayer.layer,
          Layer.mock(RelayTokens.RelayTokens, { resolveDpopAccessTokenScopes: () => null }),
          Layer.mock(EnvironmentLinker.EnvironmentLinker, {
            link: () =>
              Effect.gen(function* () {
                traceId = (yield* Effect.currentSpan.pipe(Effect.orDie)).traceId;
                return yield* new ManagedEndpointProvider.ManagedEndpointProvisioningFailed({
                  userId: "user-1",
                  environmentId: "environment-1",
                  stage: "ensure-tunnel",
                  tunnelId: "private-tunnel-id",
                  cause: new Error("private-provider-token"),
                });
              }),
          }),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(Devices.Devices, {}),
          layerTestLimiter,
          Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {}),
          Layer.mock(WebPushDeliveryQueue.WebPushDeliveryQueue, {}),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(RelayClientAuth, {
          clientBearer: (effect) =>
            Effect.provideService(effect, RelayClientPrincipal, {
              userId: "user-1",
              token: "test-token",
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
              Layer.provide(handlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const payload = yield* encodeLinkRequest({
        proof: "test-proof",
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: true,
      });
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/client/environment-links", {
            method: "POST",
            headers: {
              authorization: "Bearer test-token",
              "content-type": "application/json",
            },
            body: payload,
          }),
          Context.empty(),
        ),
      );
      expect(response.status).toBe(503);
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual({
        _tag: "RelayEnvironmentLinkUnavailableError",
        code: "environment_link_unavailable",
        reason: "managed_endpoint_provisioning_failed",
        provisioningStage: "ensure-tunnel",
        traceId,
      });
      const error = yield* decodeLinkUnavailableError(body);
      expect(relayProtectedErrorMessage(error)).toBe(
        "Relay cannot provision the managed endpoint (managed_endpoint_provisioning_failed). Failed stage: ensure-tunnel.",
      );
    }).pipe(Effect.scoped);
  });
});

describe("device listing compatibility", () => {
  it.effect("keeps v1 iOS-only while v2 returns every platform for the same account", () => {
    const iphone: RelayClientDeviceRecord = {
      deviceId: "iphone",
      label: "iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      notifications: {
        enabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
      liveActivities: { enabled: true },
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const android: RelayClientDeviceRecord = {
      ...iphone,
      deviceId: "android",
      label: "Android",
      platform: "android",
      iosMajorVersion: null,
      androidApiLevel: 36,
    };
    const layerHandlers = RelayHttpApi.layerClientApi.pipe(
      Layer.provide(layerTestLimiter),
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
          Layer.mock(RelayDb.RelayTransactions, {}),
          Layer.mock(HookInbox.HookInbox, {}),
          Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
          NodeCryptoLayer.layer,
          Layer.mock(RelayTokens.RelayTokens, { resolveDpopAccessTokenScopes: () => null }),
          Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
          Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {}),
          Layer.mock(WebPushDeliveryQueue.WebPushDeliveryQueue, {}),
          Layer.mock(Devices.Devices, {
            listForUser: ({ userId }) => {
              expect(userId).toBe("user-1");
              return Effect.succeed([iphone, android]);
            },
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(RelayClientAuth, {
          clientBearer: (effect) =>
            Effect.provideService(effect, RelayClientPrincipal, {
              userId: "user-1",
              token: "test-token",
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
              Layer.provide(layerHandlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      for (const [version, devices] of [
        ["v1", [iphone]],
        ["v2", [iphone, android]],
      ] as const) {
        const response = yield* Effect.promise(() =>
          app.handler(
            new Request(`https://relay.example.test/${version}/client/devices`, {
              headers: { authorization: "Bearer test-token" },
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.json())).toEqual({ devices });
      }
    }).pipe(Effect.scoped);
  });
});

describe("Cloudflare rate-limit retry hint", () => {
  const provisioningFailed = (cause?: unknown) =>
    new ManagedEndpointProvider.ManagedEndpointProvisioningFailed({
      userId: "user-1",
      environmentId: "env-1",
      stage: "ensure-tunnel",
      ...(cause === undefined
        ? {}
        : {
            cause: new ManagedEndpointProvider.ManagedEndpointTunnelClientError({
              operation: "list",
              cause,
            }),
          }),
    });

  const linkResponse = (failure: ManagedEndpointProvider.ManagedEndpointProvisioningFailed) => {
    const layerHandlers = RelayHttpApi.layerClientApi.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(RelayDb.RelayTransactions, {}),
          Layer.mock(HookInbox.HookInbox, {}),
          Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
          NodeCryptoLayer.layer,
          Layer.mock(RelayTokens.RelayTokens, { resolveDpopAccessTokenScopes: () => null }),
          Layer.mock(EnvironmentLinker.EnvironmentLinker, { link: () => Effect.fail(failure) }),
          Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
          Layer.mock(Devices.Devices, {}),
          layerTestLimiter,
          Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {}),
          Layer.mock(WebPushDeliveryQueue.WebPushDeliveryQueue, {}),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(RelayClientAuth, {
          clientBearer: (effect) =>
            Effect.provideService(effect, RelayClientPrincipal, {
              userId: "user-1",
              token: "test-token",
            }),
        }),
      ),
    );
    return Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
            Layer.provide(layerHandlers),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (app) => Effect.promise(() => app.dispose()),
    ).pipe(
      Effect.flatMap((app) =>
        Effect.promise(() =>
          app.handler(
            new Request("https://relay.example.test/v1/client/environment-links", {
              method: "POST",
              headers: { authorization: "Bearer test-token", "content-type": "application/json" },
              body: JSON.stringify({
                proof: "signed-proof",
                notificationsEnabled: true,
                liveActivitiesEnabled: true,
                managedTunnelsEnabled: true,
              }),
            }),
            Context.empty(),
          ),
        ),
      ),
    );
  };

  it.effect("tells a link refused during a Cloudflare pause when to retry", () =>
    Effect.gen(function* () {
      const paused = yield* linkResponse(
        provisioningFailed(
          new ManagedEndpointProvider.CloudflareApiPaused({ retryAfterMillis: 24_100 }),
        ),
      );
      expect(paused.status).toBe(503);
      expect(paused.headers.get("retry-after")).toBe("25");

      const other = yield* linkResponse(provisioningFailed());
      expect(other.status).toBe(503);
      expect(other.headers.get("retry-after")).toBeNull();
    }).pipe(Effect.scoped),
  );
});

describe("relay client authentication", () => {
  it.effect("preserves the existing Clerk session JWT path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      expect(
        yield* verifyRelayClientBearerToken(relaySettings, "eyJ0eXAiOiJKV1QifQ.e30.c2lnbmF0dXJl"),
      ).toEqual({
        sub: "user_session",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith("eyJ0eXAiOiJKV1QifQ.e30.c2lnbmF0dXJl", {
        secretKey: "clerk-secret-key",
        audience: relaySettings.clerkJwtAudience,
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );

  it.effect("falls back to Clerk OAuth token verification for the headless CLI", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "oauth-token")).toEqual({
        sub: "user_oauth",
        mode: "clerk_oauth_bearer",
      });
      expect(createClerkClient).toHaveBeenCalledWith({
        secretKey: "clerk-secret-key",
        publishableKey: "pk_test_test",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
});

const ownedRelaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  ...relaySettings,
  clerkSecretKey: Redacted.make("sk_live_fixture"),
  clerkPublishableKey: "pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA",
  clerkAuthPolicy: {
    mode: "owned",
    issuer: "https://clerk.arcwright.space",
    cliClientId: "VS3HcN01wPJotPrs",
  },
};
const nativeJwtFixture = `${Buffer.from(JSON.stringify({ typ: "JWT" })).toString("base64url")}.e30.c2ln`;
const ownedAuthFixtureApi = HttpApi.make("OwnedAuthFixture").add(
  HttpApiGroup.make("fixture")
    .add(
      HttpApiEndpoint.get("who", "/fixture", { success: Schema.Struct({ userId: Schema.String }) }),
    )
    .middleware(RelayClientAuth),
);
const ownedAuthFixtureRouter = (onPrincipal: (userId: string) => void) =>
  HttpApiBuilder.layer(ownedAuthFixtureApi).pipe(
    Layer.provide(
      HttpApiBuilder.group(ownedAuthFixtureApi, "fixture", (handlers) =>
        Effect.succeed(
          handlers.handle("who", () =>
            Effect.gen(function* () {
              const principal = yield* RelayClientPrincipal;
              onPrincipal(principal.userId);
              return { userId: principal.userId };
            }),
          ),
        ),
      ),
    ),
    Layer.provide(
      RelayHttpApi.layerClientAuth.pipe(
        Layer.provide(RelayConfiguration.layer(ownedRelaySettings)),
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  );
const ownedFixtureRequest = (token: string) =>
  new Request("https://relay.test/fixture", { headers: { authorization: `Bearer ${token}` } });

// These are request admission tests, with deliberately isolated provider fixtures.
describe("owned RelayClientAuth boundary", () => {
  it.effect.each([
    { name: "204 empty", body: undefined, status: 204 },
    { name: "null", body: null, status: 200 },
    { name: "malformed object", body: {}, status: 200 },
    { name: "malformed string", body: "provider-exception-fixture", status: 200 },
  ])(
    "real SDK $name response produces 401 without a principal or provider details",
    ({ body, status }) =>
      Effect.gen(function* () {
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof import("@clerk/backend")>("@clerk/backend"),
        );
        vi.mocked(createClerkClient).mockImplementation(actual.createClerkClient);
        const network = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
        vi.stubGlobal("fetch", network);
        let reached = false;
        const httpEffect = yield* HttpRouter.toHttpEffect(
          ownedAuthFixtureRouter(() => {
            reached = true;
          }),
        );
        const response = yield* sendRelayRequest(
          httpEffect,
          ownedFixtureRequest("oat_sensitive_fixture"),
        );
        expect(response.status).toBe(401);
        expect(reached).toBe(false);
        expect(network).toHaveBeenCalledTimes(1);
        expect(verifyToken).not.toHaveBeenCalled();
        expect(response.body._tag).toBe("Uint8Array");
        if (response.body._tag === "Uint8Array") {
          const text = new TextDecoder().decode(response.body.body);
          expect(JSON.parse(text)).toMatchObject({
            code: "auth_invalid",
            reason: "invalid_bearer",
          });
          expect(text).not.toContain("oat_sensitive_fixture");
          expect(text).not.toContain("provider-exception-fixture");
          expect(text).not.toContain("TypeError");
        }
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            vi.unstubAllGlobals();
            vi.mocked(createClerkClient).mockReset();
            vi.mocked(verifyToken).mockReset();
          }),
        ),
      ),
  );

  it.effect(
    "the DPoP route never accepts Clerk bearer credentials or invokes Clerk verification",
    () =>
      Effect.gen(function* () {
        const api = HttpApi.make("OwnedDpopFixture").add(
          HttpApiGroup.make("fixture")
            .add(
              HttpApiEndpoint.get("guarded", "/fixture", {
                success: Schema.Struct({ ok: Schema.Boolean }),
              }),
            )
            .middleware(RelayDpopClientAuth),
        );
        let reached = false;
        const httpEffect = yield* HttpRouter.toHttpEffect(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(
              HttpApiBuilder.group(api, "fixture", (handlers) =>
                Effect.succeed(
                  handlers.handle("guarded", () =>
                    Effect.sync(() => {
                      reached = true;
                      return { ok: true };
                    }),
                  ),
                ),
              ),
            ),
            Layer.provide(
              RelayHttpApi.layerDpopClientAuth.pipe(
                Layer.provide(
                  RelayTokens.layer.pipe(
                    Layer.provide(RelayConfiguration.layer(ownedRelaySettings)),
                  ),
                ),
              ),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
        );
        const oauthJwt = `${Buffer.from(JSON.stringify({ typ: "at+jwt" })).toString("base64url")}.e30.c2ln`;
        for (const token of ["oat_fixture", oauthJwt, nativeJwtFixture]) {
          for (const scheme of ["Bearer", "DPoP"]) {
            const request = new Request("https://relay.test/fixture", {
              headers: { authorization: `${scheme} ${token}` },
            });
            expect((yield* sendRelayRequest(httpEffect, request)).status).toBe(401);
          }
        }
        expect(reached).toBe(false);
        expect(createClerkClient).not.toHaveBeenCalled();
        expect(verifyToken).not.toHaveBeenCalled();
      }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.clearAllMocks()))),
  );

  it.effect("publishes only the approved opaque grant's ordinary user principal", () =>
    Effect.gen(function* () {
      let published: string | undefined;
      const httpEffect = yield* HttpRouter.toHttpEffect(
        ownedAuthFixtureRouter((userId) => {
          published = userId;
        }),
      );
      for (const subject of ["user_signupA", "user_signupB"]) {
        const verify = vi.fn().mockResolvedValue({
          clientId: "VS3HcN01wPJotPrs",
          subject,
          scopes: ["profile", "email", "openid"],
          revoked: false,
          expired: false,
          expiration: 3600,
        });
        vi.mocked(createClerkClient).mockReturnValue({ idPOAuthAccessToken: { verify } } as never);
        const response = yield* sendRelayRequest(httpEffect, ownedFixtureRequest("oat_fixture"));
        expect(response.status).toBe(200);
        expect(published).toBe(subject);
        expect(verify).toHaveBeenCalledTimes(1);
      }
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.clearAllMocks()))),
  );

  it.effect("rejects an unapproved grant before an endpoint receives a principal", () =>
    Effect.gen(function* () {
      vi.mocked(createClerkClient).mockReturnValue({
        idPOAuthAccessToken: {
          verify: vi.fn().mockResolvedValue({ clientId: "unapproved", subject: "user_signupA" }),
        },
      } as never);
      let reached = false;
      const httpEffect = yield* HttpRouter.toHttpEffect(
        ownedAuthFixtureRouter(() => {
          reached = true;
        }),
      );
      expect((yield* sendRelayRequest(httpEffect, ownedFixtureRequest("oat_fixture"))).status).toBe(
        401,
      );
      expect(reached).toBe(false);
      expect(verifyToken).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.clearAllMocks()))),
  );

  it.effect("deadline prevents a late BAPI success from publishing any principal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finish: ((value: unknown) => void) | undefined;
      vi.mocked(createClerkClient).mockReturnValue({
        idPOAuthAccessToken: {
          verify: () =>
            new Promise((resolve) => {
              finish = resolve;
              Deferred.doneUnsafe(started, Effect.void);
            }),
        },
      } as never);
      let reached = false;
      const httpEffect = yield* HttpRouter.toHttpEffect(
        ownedAuthFixtureRouter(() => {
          reached = true;
        }),
      );
      const fiber = yield* sendRelayRequest(
        traceRelayHttpRequestWith(httpEffect, Layer.empty),
        ownedFixtureRequest("oat_fixture"),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.millis(RELAY_REQUEST_DEADLINE_MS));
      expect((yield* Fiber.join(fiber)).status).toBe(504);
      finish!({
        clientId: "VS3HcN01wPJotPrs",
        subject: "user_signupA",
        scopes: ["openid", "profile", "email"],
        revoked: false,
        expired: false,
        expiration: 3600,
      });
      yield* Effect.promise(() => Promise.resolve());
      expect(reached).toBe(false);
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.clearAllMocks()))),
  );

  it.effect("the actual token exchange rejects opaque OAuth before proof verification", () =>
    Effect.gen(function* () {
      const proof = vi.fn(() => Effect.succeed(verifiedFixtureProof));
      const issue = vi.fn(() => Effect.succeed("relay-token"));
      const httpEffect = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.token)).pipe(
          Layer.provide(
            RelayHttpApi.layerTokenApi.pipe(
              Layer.provide(layerTestLimiter),
              Layer.provide(
                Layer.mergeAll(
                  RelayConfiguration.layer(ownedRelaySettings),
                  NodeCryptoLayer.layer,
                  Layer.mock(DpopProofs.DpopProofReplay, {
                    verify: proof,
                    consumeVerified: () => Effect.succeed("fixture-thumbprint"),
                  }),
                  Layer.mock(RelayTokens.RelayTokens, {
                    resolveDpopAccessTokenScopes: () => ["environment:connect"],
                    issueDpopAccessToken: issue,
                  }),
                ),
              ),
            ),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
      );
      const request = (subjectToken: string) =>
        new Request("https://relay.example.test/v1/client/dpop-token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: "fixture-proof" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            subject_token: subjectToken,
            resource: relaySettings.relayIssuer,
            client_id: "t3-mobile",
            scope: "environment:connect",
          }),
        });
      expect((yield* sendRelayRequest(httpEffect, request("oat_fixture"))).status).toBe(401);
      expect(proof).not.toHaveBeenCalled();
      expect(createClerkClient).not.toHaveBeenCalled();
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_signupA",
        aud: "t3-code-relay",
        iss: "https://clerk.arcwright.space",
      } as never);
      expect((yield* sendRelayRequest(httpEffect, request(nativeJwtFixture))).status).toBe(200);
      expect(issue).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_signupA",
          clientId: "t3-mobile",
          proofKeyThumbprint: "fixture-thumbprint",
        }),
      );
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => vi.clearAllMocks()))),
  );
});

describe("relay DPoP failure mapping", () => {
  it("maps verifier failures to safe client-facing categories", () => {
    const mappings = [
      ["time_window", "time_window"],
      ["key_mismatch", "key_mismatch"],
      ["method_mismatch", "request_mismatch"],
      ["url_mismatch", "request_mismatch"],
      ["access_token_hash_mismatch", "token_mismatch"],
      ["replayed", "replay"],
      ["missing_proof", "invalid_proof"],
      ["malformed_proof", "invalid_proof"],
      ["invalid_signature", "invalid_proof"],
      ["invalid_proof", "invalid_proof"],
    ] as const;

    for (const [code, expected] of mappings) {
      expect(relayDpopFailureReason(code)).toBe(expected);
    }
  });
});

describe("relay environment authentication", () => {
  it.effect("preserves credential lookup persistence failures as internal errors", () => {
    const failure = new EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError({
      stage: "lookup-credential",
      cause: "database unavailable",
    });
    const credentials: EnvironmentCredentials.EnvironmentCredentials["Service"] = {
      create: () => Effect.die("unused create"),
      authenticate: () => Effect.fail(failure),
      revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
    };

    return Effect.gen(function* () {
      const auth = yield* RelayEnvironmentAuth;
      const error = yield* Effect.flip(
        auth.environmentBearer(Effect.succeed(HttpServerResponse.empty()), {
          credential: Redacted.make("environment-credential"),
          endpoint: {} as never,
          group: {} as never,
        }),
      );

      expect(Predicate.isTagged(error, "RelayInternalError")).toBe(true);
      if (Predicate.isTagged(error, "RelayInternalError")) {
        expect(error.reason).toBe("persistence_failed");
      }
    }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://relay.test/v1/server/link")),
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
      Effect.provideService(HttpRouter.RouteContext, {
        params: {},
        route: {} as never,
      }),
      Effect.provide(
        RelayHttpApi.layerEnvironmentAuth.pipe(
          Layer.provide(Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, credentials)),
        ),
      ),
      Effect.scoped,
    );
  });
});

function layerRelayUnlinkTest(input?: {
  readonly getForUser?: EnvironmentLinks.EnvironmentLinks["Service"]["getForUser"];
  readonly revokeCleanup?: ManagedEndpointLifecycle.ManagedEndpointLifecycle["Service"]["revokeAndRequestCleanup"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
  readonly provision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["provision"];
  readonly reconcileOrigin?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["reconcileOrigin"];
  readonly clearInbox?: HookInbox.HookInbox["Service"]["clear"];
}) {
  return Layer.mergeAll(
    Layer.mock(HookInbox.HookInbox, { clear: input?.clearInbox ?? (() => Effect.void) }),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {
      getForUser: input?.getForUser ?? (() => Effect.succeed(null)),
    }),
    Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {
      revokeAndRequestCleanup:
        input?.revokeCleanup ??
        (() => Effect.succeed({ revoked: false, target: null, tunnelName: null })),
    }),
    Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
      provision: input?.provision ?? (() => Effect.die("unused provision")),
      reconcileOrigin: input?.reconcileOrigin ?? (() => Effect.succeed("ready")),
      deprovision: input?.deprovision ?? (() => Effect.succeed(true)),
    }),
  );
}

const linkedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Environment 1",
  endpoint: {
    httpBaseUrl: "https://environment-1.example.test/",
    wsBaseUrl: "wss://environment-1.example.test/ws",
    providerKind: "cloudflare_tunnel",
  },
  environmentPublicKey: "public-key",
  linkIncarnationId: "fixture-incarnation",
  linkedAt: "2026-07-28T00:00:00.000Z",
} as const;

describe("relay managed tunnel recovery", () => {
  it.effect("binds recovery requests to the host, cloud user, and T3 service origin", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const now = yield* DateTime.now;
      const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
      const proof = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
        payload: {
          iss: "t3-env:environment-1",
          aud: "https://relay.example.test",
          sub: "environment-1",
          jti: "recovery-proof",
          iat: issuedAt,
          exp: issuedAt + 60,
          action: "recover",
          environmentId: "environment-1",
          cloudUserId: "user-1",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        },
      });
      const request = {
        action: "recover" as const,
        proof,
        userId: "user-1",
        environmentId: "environment-1",
        environmentPublicKey: keyPair.publicKey,
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      };

      yield* verifyEnvironmentTunnelRecoveryProof(request);

      const wrongOwner = yield* Effect.flip(
        verifyEnvironmentTunnelRecoveryProof({ ...request, userId: "user-2" }),
      );
      expect(wrongOwner).toMatchObject({ _tag: "Unauthorized" });

      const wrongOrigin = yield* Effect.flip(
        verifyEnvironmentTunnelRecoveryProof({
          ...request,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 5432 },
        }),
      );
      expect(wrongOrigin).toMatchObject({ _tag: "Unauthorized" });

      const wrongAction = yield* Effect.flip(
        verifyEnvironmentTunnelRecoveryProof({
          action: "register",
          proof,
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: keyPair.publicKey,
          tunnelId: "existing-tunnel",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      );
      expect(wrongAction).toMatchObject({ _tag: "Unauthorized" });
    }).pipe(Effect.provideService(RelayConfiguration.RelayConfiguration, relaySettings)),
  );

  it.effect("rejects a signed registration proof for a different origin", () =>
    Effect.gen(function* () {
      const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const now = yield* DateTime.now;
      const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
      const proof = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
        payload: {
          iss: "t3-env:environment-1",
          aud: "https://relay.example.test",
          sub: "environment-1",
          jti: "registration-origin-proof",
          iat: issuedAt,
          exp: issuedAt + 60,
          action: "register",
          environmentId: "environment-1",
          cloudUserId: "user-1",
          tunnelId: "existing-tunnel",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        },
      });

      const error = yield* Effect.flip(
        verifyEnvironmentTunnelRecoveryProof({
          action: "register",
          proof,
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: keyPair.publicKey,
          tunnelId: "existing-tunnel",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 5432 },
        }),
      );

      expect(error).toMatchObject({ _tag: "Unauthorized" });
    }).pipe(Effect.provideService(RelayConfiguration.RelayConfiguration, relaySettings)),
  );

  it.effect("registration passes the exact captured active authority to reconciliation", () => {
    const calls: unknown[] = [];
    return registerEnvironmentTunnelRecovery({
      userId: "user-1",
      environmentId: "environment-1",
      environmentPublicKey: "public-key",
      tunnelId: "tunnel-id",
      origin: { localHttpHost: "localhost", localHttpPort: 3000 },
    }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result).toEqual({ status: "ready" }))),
      Effect.provide(
        layerRelayUnlinkTest({
          getForUser: () => Effect.succeed(linkedEnvironmentRecord),
          reconcileOrigin: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return "ready" as const;
            }),
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() =>
          expect(calls).toEqual([
            {
              userId: "user-1",
              environmentId: "environment-1",
              tunnelId: "tunnel-id",
              origin: { localHttpHost: "localhost", localHttpPort: 3000 },
              expectedLink: {
                environmentPublicKey: "public-key",
                expectedLinkIncarnationId: "fixture-incarnation",
                endpoint: linkedEnvironmentRecord.endpoint,
              },
            },
          ]),
        ),
      ),
    );
  });
  it.effect.each(["different-key", "manual"] as const)(
    "rejects $0 recovery authority before provider work",
    (kind) => {
      let providerCalls = 0;
      return Effect.flip(
        recoverEnvironmentTunnelRecord({
          userId: "user-1",
          environmentId: "environment-1",
          environmentPublicKey: kind === "different-key" ? "wrong" : "public-key",
          origin: { localHttpHost: "localhost", localHttpPort: 3000 },
        }),
      ).pipe(
        Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("Unauthorized"))),
        Effect.provide(
          layerRelayUnlinkTest({
            getForUser: () =>
              Effect.succeed({
                ...linkedEnvironmentRecord,
                endpoint: {
                  ...linkedEnvironmentRecord.endpoint,
                  providerKind: kind === "manual" ? "manual" : "cloudflare_tunnel",
                },
              }),
            provision: () =>
              Effect.sync(() => {
                providerCalls++;
                throw new Error("Unexpected provider");
              }),
          }),
        ),
        Effect.tap(() => Effect.sync(() => expect(providerCalls).toBe(0))),
      );
    },
  );
  it.effect(
    "recovery passes key/incarnation/endpoint as publication and preserves public response",
    () => {
      const inputs: unknown[] = [];
      const runtime = {
        providerKind: "cloudflare_tunnel" as const,
        tunnelId: "tunnel",
        connectorToken: "fixture-token",
      };
      return recoverEnvironmentTunnelRecord({
        userId: "user-1",
        environmentId: "environment-1",
        environmentPublicKey: "public-key",
        origin: { localHttpHost: "localhost", localHttpPort: 3000 },
      }).pipe(
        Effect.tap((value) =>
          Effect.sync(() =>
            expect(value).toEqual({
              endpoint: linkedEnvironmentRecord.endpoint,
              endpointRuntime: runtime,
            }),
          ),
        ),
        Effect.provide(
          layerRelayUnlinkTest({
            getForUser: () => Effect.succeed(linkedEnvironmentRecord),
            provision: (input) =>
              Effect.sync(() => {
                inputs.push(input);
                return {
                  kind: "recovered" as const,
                  endpoint: linkedEnvironmentRecord.endpoint,
                  runtime,
                };
              }),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() =>
            expect(inputs).toEqual([
              {
                userId: "user-1",
                environmentId: "environment-1",
                origin: { localHttpHost: "localhost", localHttpPort: 3000 },
                publication: {
                  kind: "recover",
                  environmentPublicKey: "public-key",
                  expectedLinkIncarnationId: "fixture-incarnation",
                  endpoint: linkedEnvironmentRecord.endpoint,
                },
              },
            ]),
          ),
        ),
      );
    },
  );
});

describe("relay environment unlink", () => {
  it.effect.each([true, false])(
    "uses committed aggregate capture for revoked=$0 and cleanup without rereading authority",
    (revoked) => {
      const order: string[] = [];
      const target = {
        key: { userId: "user-1", environmentId: "environment-1" },
        allocationId: "fixture-allocation",
        generation: 2,
        tunnelId: null,
      };
      return unlinkEnvironmentRecord({ ...target.key, managedEndpointNamespace: "prod" }).pipe(
        Effect.tap((value) => Effect.sync(() => expect(value).toBe(revoked))),
        Effect.provide(
          layerRelayUnlinkTest({
            revokeCleanup: () =>
              Effect.sync(() => {
                order.push("commit-revocation");
                return {
                  revoked,
                  target,
                  tunnelName: "t3coderelay-managedendpoint-prod-0123456789abcdef",
                };
              }),
            clearInbox: () =>
              Effect.sync(() => {
                order.push("clear-hooks");
              }),
            deprovision: (input) =>
              Effect.sync(() => {
                expect(input.target).toBe(target);
                order.push("cleanup");
                return false;
              }),
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => expect(order).toEqual(["commit-revocation", "clear-hooks", "cleanup"])),
        ),
      );
    },
  );
  it.effect("does not dispatch cleanup when revocation commit fails", () => {
    let calls = 0;
    return Effect.flip(
      unlinkEnvironmentRecord({ userId: "user-1", environmentId: "environment-1" }),
    ).pipe(
      Effect.tap((error) =>
        Effect.sync(() => expect(error._tag).toBe("ManagedEndpointLifecyclePersistenceError")),
      ),
      Effect.provide(
        layerRelayUnlinkTest({
          revokeCleanup: () =>
            Effect.fail(
              new ManagedEndpointLifecycle.LifecyclePersistenceError({
                operation: "revoke-cleanup",
                userId: "user-1",
                environmentId: "environment-1",
                cause: "fixture commit failure",
              }),
            ),
          deprovision: () =>
            Effect.sync(() => {
              calls++;
              return true;
            }),
        }),
      ),
      Effect.tap(() => Effect.sync(() => expect(calls).toBe(0))),
    );
  });
  it.effect("cleanup failure leaves committed revocation successful and does not retarget", () => {
    let calls = 0;
    return unlinkEnvironmentRecord({ userId: "user-1", environmentId: "environment-1" }).pipe(
      Effect.tap((value) => Effect.sync(() => expect(value).toBe(true))),
      Effect.provide(
        layerRelayUnlinkTest({
          revokeCleanup: () => Effect.succeed({ revoked: true, target: null, tunnelName: null }),
          deprovision: () =>
            Effect.suspend(() => {
              calls++;
              return Effect.fail(
                new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
                  stage: "delete-tunnel",
                  userId: "user-1",
                  environmentId: "environment-1",
                  cause: "fixture",
                }),
              );
            }),
        }),
      ),
      Effect.tap(() => Effect.sync(() => expect(calls).toBe(1))),
    );
  });
});

describe("relay request tracing", () => {
  it.effect(
    "does not parent endpoint spans to an ambient parent captured while building handlers",
    () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const ambientParent = Tracer.externalSpan({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          sampled: true,
        });
        const endpoint = yield* withoutCapturedRequestContext(
          Effect.context<never>().pipe(
            Effect.map((capturedContext: Context.Context<never>) =>
              Effect.succeed(HttpServerResponse.empty({ status: 204 })).pipe(
                Effect.withSpan("relay.test.endpoint"),
                Effect.provideContext(capturedContext),
              ),
            ),
          ),
        ).pipe(Effect.provideService(Tracer.ParentSpan, ambientParent));
        const request = HttpServerRequest.fromWeb(
          new Request("https://relay.test/v1/mobile/devices?client=mobile", {
            method: "POST",
            headers: {
              authorization: "Bearer secret",
              dpop: "signed-proof",
            },
          }),
        );

        yield* traceRelayHttpRequestWith(endpoint, Layer.succeed(Tracer.Tracer, tracer)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );

        expect(spans.map((span) => span.name)).toEqual(["POST", "relay.test.endpoint"]);
        expect(spans[0]?.kind).toBe("server");
        expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
        expect(spans[0]?.attributes.get("http.response.status_code")).toBe(204);
        expect(spans[0]?.attributes.get("http.request.header.authorization")).toBeUndefined();
        expect(spans[0]?.attributes.get("http.request.header.dpop")).toBeUndefined();
        expect(Option.isNone(spans[0]!.parent)).toBe(true);
        expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]?.spanId);
      }),
  );

  it.effect("records the Cloudflare edge a request entered through on its server span", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const source = new Request("https://relay.test/v1/environments/env-1/connect", {
        method: "POST",
      });
      Object.defineProperty(source, "cf", {
        value: { colo: "JNB", country: "ZA", continent: "AF", asn: 37_100 },
      });

      yield* traceRelayHttpRequestWith(
        Effect.succeed(HttpServerResponse.empty({ status: 204 })),
        Layer.succeed(Tracer.Tracer, tracer),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(source),
        ),
      );

      const server = spans.find((span) => span.kind === "server");
      expect(server?.attributes.get("relay.edge.colo")).toBe("JNB");
      expect(server?.attributes.get("relay.edge.country")).toBe("ZA");
      expect(server?.attributes.get("relay.edge.continent")).toBe("AF");
    }),
  );

  it.effect("records one server span inside the worker's disabled HTTP tracer", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices", { method: "POST" }),
      );

      yield* HttpMiddleware.tracer(
        traceRelayHttpRequestWith(
          Effect.succeed(HttpServerResponse.empty({ status: 204 })),
          Layer.empty,
        ),
      ).pipe(
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.withTracer(tracer),
      );
      yield* Effect.yieldNow;

      expect(spans.filter((span) => span.kind === "server")).toHaveLength(1);
      expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
    }),
  );

  it.effect("lets managed tunnel setup finish after the ordinary request deadline", () =>
    Effect.gen(function* () {
      for (const [method, path] of [
        ["POST", "/v1/client/environment-links"],
        ["DELETE", "/v1/client/environment-links/fixture-env"],
      ] as const) {
        const request = HttpServerRequest.fromWeb(
          new Request(`https://relay.test${path}`, { method }),
        );
        const fiber = yield* traceRelayHttpRequestWith(
          Effect.sleep("12 seconds").pipe(Effect.as(HttpServerResponse.empty({ status: 200 }))),
          Layer.empty,
        ).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.forkChild,
        );
        yield* TestClock.adjust("12 seconds");
        expect((yield* Fiber.join(fiber)).status).toBe(200);
      }
    }),
  );

  it.effect("still cancels stalled tunnel setup before the client's longer timeout", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/client/environment-links", { method: "POST" }),
      );
      const fiber = yield* traceRelayHttpRequestWith(Effect.never, Layer.empty).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.forkChild,
      );
      yield* TestClock.adjust("45 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe(504);
    }),
  );

  it.effect("fails hung requests with a 504 before the client's 10s abort", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices", { method: "POST" }),
      );

      const fiber = yield* traceRelayHttpRequestWith(
        Effect.never,
        Layer.succeed(Tracer.Tracer, tracer),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(RELAY_REQUEST_DEADLINE_MS));
      const response = yield* Fiber.join(fiber);

      expect(response.status).toBe(504);
      expect(spans[0]?.attributes.get("relay.request.deadline_exceeded")).toBe(true);
      expect(spans[0]?.attributes.get("http.response.status_code")).toBe(504);
    }),
  );
});

describe("relay routing fallback", () => {
  it.effect("publishes activity for escaped delegated thread IDs longer than 100 characters", () =>
    Effect.gen(function* () {
      const environmentId = "environment-1";
      const environmentPublicKey = "environment-public-key";
      const published: Array<
        Parameters<AgentActivityPublisher.AgentActivityPublisher["Service"]["publish"]>[0]
      > = [];
      const verified: Array<
        Parameters<
          EnvironmentPublishSignatures.EnvironmentPublishSignatures["Service"]["verify"]
        >[0]
      > = [];
      const layerPublisher = Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {
        publishToRecipients: (input) =>
          Effect.sync(() => {
            published.push(input);
            return { ok: true as const, deliveries: [] };
          }),
        replayForLiveActivityRegistration: () => Effect.succeed(null),
        endIdleLiveActivities: Effect.void,
      });
      const layerSignatures = Layer.succeed(
        EnvironmentPublishSignatures.EnvironmentPublishSignatures,
        {
          verify: () => Effect.void,
          consumeVerified: () => Effect.void,
          verifyStateless: (input) =>
            Effect.sync(() => {
              verified.push(input);
              return {
                ...verifiedFixtureProof,
                environmentId: input.environmentId,
                threadId: input.threadId,
              };
            }),
        },
      );
      const layerAuth = Layer.succeed(RelayEnvironmentAuth, {
        environmentBearer: (effect) =>
          effect.pipe(
            Effect.provideService(RelayEnvironmentPrincipal, {
              environmentId,
              environmentPublicKey,
            }),
          ),
      });
      const layerRoutes = HttpApiBuilder.layer(
        HttpApi.make("RelayApi").add(RelayApi.groups.server),
      ).pipe(
        Layer.provide(
          RelayHttpApi.layerServerApi.pipe(
            Layer.provide(layerTestLimiter),
            Layer.provide(NodeCryptoLayer.layer),
            HttpRouter.provideRequest(
              Layer.mergeAll(
                Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
                Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
                Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {}),
                Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
                Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
              ),
            ),
            Layer.provide([
              layerPublisher,
              layerSignatures,
              Layer.mock(HeldHooks.HeldHooks, {}),
              Layer.mock(EnvironmentLinks.EnvironmentLinks, {
                listDeliveryUsersForEnvironment: () => Effect.succeed([]),
              }),
            ]),
          ),
        ),
        Layer.provide(layerAuth),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
      );
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(layerRoutes, RelayHttpApi.layerNotFoundRoute, RelayHttpApi.layerCors),
      ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));
      const threadIds = [
        "b7c8c522-d244-43dc-875f-7224fce79912",
        "t".repeat(512),
        "thread:delegated-task:command%3Amcp%3Ab7c8c522-d244-43dc-875f-7224fce79912%3Adelegate-task%3Agreet-subagent-20260813",
      ];
      for (const threadId of threadIds) {
        const request = HttpServerRequest.fromWeb(
          new Request(
            `https://relay.test/v1/environments/${environmentId}/threads/${encodeURIComponent(threadId)}/agent-activity`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer environment-credential",
                "content-type": "application/json",
              },
              body: '{"state":null,"proof":"signed-proof"}',
            },
          ),
        );
        const response = yield* httpEffect.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
        expect(response.status).toBe(200);
      }
      expect(published).toEqual(
        threadIds.map((threadId) => ({
          environmentId,
          environmentPublicKey,
          threadId,
          state: null,
          deliveryUsers: [],
        })),
      );
      expect(verified.map((input) => input.threadId)).toEqual(threadIds);
    }).pipe(Effect.scoped),
  );

  it.effect("redirects the relay root to the API docs", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          RelayHttpApi.layerDocsRedirectRoute,
          RelayHttpApi.layerNotFoundRoute,
          RelayHttpApi.layerCors,
        ),
      );
      const response = yield* sendRelayRequest(httpEffect, new Request("https://relay.test/"));

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/docs");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );

  it.effect("returns a CORS-compatible 404 response for unmatched paths", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.merge(RelayHttpApi.layerNotFoundRoute, RelayHttpApi.layerCors),
      );
      const response = yield* sendRelayRequest(
        httpEffect,
        new Request("https://relay.test/v1/environmentsd", { method: "GET" }),
      );

      expect(response.status).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );
});

describe("relay CORS", () => {
  const origin = "https://app.t3.codes";

  class HandlerFailed extends Data.TaggedError("HandlerFailed") {}

  it.effect("answers preflight requests without reaching a route", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.merge(RelayHttpApi.layerNotFoundRoute, RelayHttpApi.layerCors),
      );
      const response = yield* sendRelayRequest(
        httpEffect,
        new Request("https://relay.test/v1/client/environments", {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,dpop,content-type",
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(
        response.headers["access-control-allow-methods"]?.split(",").map((method) => method.trim()),
      ).toEqual(["GET", "POST", "PUT", "DELETE", "OPTIONS"]);
      expect(response.headers).toMatchObject({
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,b3,traceparent,content-type,dpop",
        "access-control-expose-headers": "traceparent,www-authenticate,retry-after",
        "access-control-max-age": "86400",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("adds CORS headers to handler failures and defects", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/v1/fail", Effect.fail(new HandlerFailed())),
          HttpRouter.add("GET", "/v1/die", Effect.die(new Error("handler defect"))),
          RelayHttpApi.layerNotFoundRoute,
          RelayHttpApi.layerCors,
        ),
      );
      for (const path of ["/v1/fail", "/v1/die"]) {
        const response = yield* sendRelayRequest(
          httpEffect,
          new Request(`https://relay.test${path}`, { headers: { origin } }),
        );

        expect(response.status).toBe(500);
        expect(response.headers["access-control-allow-origin"]).toBe("*");
        expect(response.headers["access-control-expose-headers"]).toBe(
          "traceparent,www-authenticate,retry-after",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("adds CORS headers to the request deadline response", () =>
    Effect.gen(function* () {
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/v1/hang", Effect.never),
          RelayHttpApi.layerNotFoundRoute,
          RelayHttpApi.layerCors,
        ),
      );
      const fiber = yield* sendRelayRequest(
        traceRelayHttpRequestWith(httpEffect, Layer.empty),
        new Request("https://relay.test/v1/hang", { headers: { origin } }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(RELAY_REQUEST_DEADLINE_MS));
      const response = yield* Fiber.join(fiber);

      expect(response.status).toBe(504);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-expose-headers"]).toBe(
        "traceparent,www-authenticate,retry-after",
      );
    }).pipe(Effect.scoped),
  );
});

// Sends a request through Effect's request handler, which applies pre-response
// handlers to the response it sends, as the Workers runtime does.
const sendRelayRequest = Effect.fnUntraced(function* <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  request: Request,
) {
  const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
  yield* HttpEffect.toHandled(httpEffect, (_request, response) =>
    Deferred.succeed(sent, response),
  ).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.exit,
  );
  return yield* Deferred.await(sent);
});

describe("anonymous PWA deployment policy at exported HTTP handlers", () => {
  it.effect.each(["owned", "malformed", "legacy"] as const)(
    "%s policy guards config, register, publish and test while removal remains available",
    (mode) => {
      const calls = { register: 0, verify: 0, transition: 0, get: 0, queue: 0, remove: 0 };
      const queued: Array<WebPushDeliveryQueue.WebPushQueueInput> = [];
      let verified = false;
      const config: RelayConfiguration.RelayConfiguration["Service"] = {
        ...relaySettings,
        webPush: {
          subject: "mailto:fixture@example.test",
          publicKey: "fixture-vapid",
          privateKey: Redacted.make("fixture-private"),
        },
        ...(mode === "legacy"
          ? {}
          : {
              clerkAuthPolicy: {
                mode: "owned",
                issuer: "https://clerk.arcwright.space",
                cliClientId: "fixture_cli",
              },
              clerkPublishableKey:
                mode === "malformed" ? "malformed" : `pk_test_${btoa("clerk.arcwright.space$")}`,
            }),
      };
      const installation = {
        installationId: "fixture-installation",
        installationSecret: "fixture-secret",
      };
      const preferences = {
        enabled: true,
        notifyOnCompletion: true,
        notifyOnPlanReady: true,
        notifyOnInput: true,
        notifyOnFailure: true,
        showProjectAndThreadNames: false,
      };
      const subscription: WebPushSubscriptions.WebPushNotification["subscription"] = {
        id: "fixture-subscription",
        incarnationId: "00000000-0000-4000-8000-000000000001",
        userId: "pwa:fixture-installation",
        environmentId: "fixture-environment",
        installationId: installation.installationId,
        installationSecretHash: "fixture-hash",
        endpoint: "https://push.example.test/fixture",
        p256dh: "key",
        auth: "auth",
        preferencesJson: preferences,
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      const layerHandlers = RelayHttpApi.pwaApi.pipe(
        Layer.provide(layerTestLimiter),
        Layer.provide(NodeCryptoLayer.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RelayConfiguration.RelayConfiguration, config),
            Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
              registerPwaPublic: () =>
                Effect.sync(() => {
                  calls.register++;
                  return { subscriptionId: subscription.id };
                }),
              transitionEnvironment: ({ environmentId, state }) =>
                Effect.sync(() => {
                  expect(verified).toBe(true);
                  expect(environmentId).toBe("fixture-environment");
                  expect(state?.threadId).toBe("fixture-thread");
                  calls.transition++;
                  return [
                    {
                      notificationKind: "input_required",
                      source: {
                        environmentId: "fixture-environment",
                        threadId: "fixture-thread",
                        notificationKind: "input_required",
                        stateVersion: {
                          updatedAt: "1970-01-01T00:00:00.000Z",
                          phase: "waiting_for_input",
                          hasActionableProposedPlan: false,
                        },
                      },
                      eventId: "opaque-with-no-kind",
                      deepLink: "/",
                      showProjectAndThreadNames: false,
                      title: "private title",
                      body: "private body",
                      subscription,
                    },
                  ];
                }),
              getPwa: () =>
                Effect.sync(() => {
                  calls.get++;
                  return subscription;
                }),
              removePwaPublic: () =>
                Effect.sync(() => {
                  calls.remove++;
                  return true;
                }),
            }),
            Layer.mock(WebPushDeliveryQueue.WebPushDeliveryQueue, {
              enqueue: (input) =>
                Effect.sync(() => {
                  calls.queue++;
                  queued.push(input);
                  return {
                    deviceId: subscription.id,
                    kind: "web_push_notification" as const,
                    ok: true,
                    queued: true,
                    apnsStatus: null,
                    apnsReason: null,
                    apnsId: null,
                  };
                }),
            }),
            Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {
              consumeVerified: () => Effect.void,
              verifyStateless: (input) =>
                Effect.sync(() => {
                  calls.verify++;
                  verified = true;
                  return {
                    ...verifiedFixtureProof,
                    environmentId: input.environmentId,
                    threadId: input.threadId,
                  };
                }),
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.pwa)).pipe(
                Layer.provide(layerHandlers),
                Layer.provide(HttpServer.layerServices),
              ),
              { disableLogger: true },
            ),
          ),
          (app) => Effect.promise(() => app.dispose()),
        );
        for (const [method, path, body] of [
          ["GET", "/v1/pwa/web-push/config", undefined],
          [
            "PUT",
            "/v1/pwa/web-push/subscriptions",
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: "key", auth: "auth" },
              environmentId: "fixture-environment",
              installation,
              preferences,
            },
          ],
          [
            "POST",
            "/v1/pwa/environments/fixture-environment/threads/fixture-thread/agent-activity",
            {
              environmentPublicKey: "fixture-public-key",
              state: {
                environmentId: "fixture-environment",
                threadId: "fixture-thread",
                projectTitle: "Private",
                threadTitle: "Private",
                modelTitle: "Codex",
                phase: "waiting_for_input",
                headline: "Input",
                updatedAt: "1970-01-01T00:00:00.000Z",
                deepLink: "/",
              },
              proof: "fixture-proof",
            },
          ],
          ["POST", "/v1/pwa/web-push/subscriptions/fixture-subscription/test", { installation }],
        ] as const) {
          const response = yield* Effect.promise(() =>
            app.handler(
              new Request(`https://relay.example.test${path}`, {
                method,
                ...(body === undefined
                  ? {}
                  : {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(body),
                    }),
              }),
            ),
          );
          const json = yield* Effect.promise(() => response.json());
          if (mode === "legacy") expect(response.status).toBe(200);
          else {
            expect(response.status).toBe(500);
            expect(json).toMatchObject({ code: "internal_error", reason: "upstream_unavailable" });
          }
        }
        expect(calls).toEqual(
          mode === "legacy"
            ? { register: 1, verify: 1, transition: 1, get: 1, queue: 2, remove: 0 }
            : { register: 0, verify: 0, transition: 0, get: 0, queue: 0, remove: 0 },
        );
        if (mode === "legacy") {
          expect(queued[0]).toEqual({
            kind: "activity",
            userId: subscription.userId,
            subscriptionId: subscription.id,
            subscriptionIncarnationId: subscription.incarnationId,
            eventId: "opaque-with-no-kind",
            showProjectAndThreadNames: false,
            provenance: {
              environmentId: "fixture-environment",
              environmentPublicKey: "fixture-public-key",
              threadId: "fixture-thread",
              notificationKind: "input_required",
              linkIncarnationId: null,
              stateVersion: {
                updatedAt: "1970-01-01T00:00:00.000Z",
                phase: "waiting_for_input",
                hasActionableProposedPlan: false,
              },
            },
          });
          expect(queued[1]).toEqual({
            kind: "test",
            userId: subscription.userId,
            subscriptionId: subscription.id,
            subscriptionIncarnationId: subscription.incarnationId,
          });
        } else expect(queued).toEqual([]);
        const removed = yield* Effect.promise(() =>
          app.handler(
            new Request(
              "https://relay.example.test/v1/pwa/web-push/subscriptions/fixture-subscription/remove",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ installation }),
              },
            ),
          ),
        );
        expect(removed.status).toBe(200);
        expect(yield* Effect.promise(() => removed.json())).toEqual({ ok: true });
        expect(calls.remove).toBe(1);
      }).pipe(Effect.scoped);
    },
  );
});

describe("test Web Push authority and queue acceptance through exported handlers", () => {
  it.effect.each([
    { path: "account", acceptance: "accepted" },
    { path: "account", acceptance: "denied" },
    { path: "account", acceptance: "missing" },
    { path: "account", acceptance: "failed" },
    { path: "anonymous", acceptance: "accepted" },
    { path: "anonymous", acceptance: "denied" },
    { path: "anonymous", acceptance: "missing" },
    { path: "anonymous", acceptance: "failed" },
  ] as const)(
    "$path test uses current selected subscription and reports $acceptance",
    ({ path, acceptance }) => {
      const jobs: Array<WebPushDeliveryQueue.WebPushQueueInput> = [];
      const subscription: WebPushSubscriptions.WebPushNotification["subscription"] = {
        id: "selected-subscription",
        incarnationId: "00000000-0000-4000-8000-000000000005",
        userId: path === "account" ? "user-1" : "pwa:fixture-installation",
        environmentId: path === "account" ? null : "fixture-environment",
        installationId: path === "account" ? null : "fixture-installation",
        installationSecretHash: path === "account" ? null : "fixture-hash",
        endpoint: "https://push.example.test",
        p256dh: "fixture",
        auth: "fixture",
        preferencesJson: {
          enabled: true,
          notifyOnCompletion: true,
          notifyOnPlanReady: true,
          notifyOnInput: true,
          notifyOnFailure: true,
          showProjectAndThreadNames: true,
        },
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      const installation = {
        installationId: "fixture-installation",
        installationSecret: "verified-secret",
      };
      const deps = Layer.mergeAll(
        Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
        NodeCryptoLayer.layer,
        Layer.mock(RelayTokens.RelayTokens, { resolveDpopAccessTokenScopes: () => null }),
        Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
        Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
        Layer.mock(Devices.Devices, {}),
        layerTestLimiter,
        Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {}),
        Layer.mock(WebPushDeliveryQueue.WebPushDeliveryQueue, {}),
        Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
        Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
          get: (input) => {
            expect(input).toEqual({ userId: "user-1", subscriptionId: subscription.id });
            return Effect.succeed(acceptance === "missing" ? null : subscription);
          },
          getPwa: (input) => {
            expect(input).toEqual({ ...installation, subscriptionId: subscription.id });
            return Effect.succeed(acceptance === "missing" ? null : subscription);
          },
        }),
        Layer.succeed(WebPushDeliveryQueue.WebPushDeliveryQueue, {
          enqueue: (input) => {
            jobs.push(input);
            if (acceptance === "failed")
              return Effect.fail(
                new WebPushDeliveryQueue.WebPushDeliveryQueueError({
                  cause: new Error("queue unavailable"),
                }),
              );
            return Effect.succeed({
              deviceId: subscription.id,
              kind: "web_push_notification" as const,
              ok: acceptance === "accepted",
              queued: acceptance === "accepted",
              apnsStatus: null,
              apnsReason: null,
              apnsId: null,
            });
          },
        }),
      );
      const auth = Layer.succeed(RelayClientAuth, {
        clientBearer: (effect) =>
          Effect.provideService(effect, RelayClientPrincipal, {
            userId: "user-1",
            token: "fixture-token",
          }),
      });
      const clientHandlers = RelayHttpApi.layerClientApi.pipe(
        Layer.provide(layerTestLimiter),
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
            Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
            Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
            Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
            Layer.mock(RelayDb.RelayTransactions, {}),
            Layer.mock(HookInbox.HookInbox, {}),
            Layer.mock(ManagedEndpointLifecycle.ManagedEndpointLifecycle, {}),
          ),
        ),
        Layer.provide(deps),
        Layer.provideMerge(auth),
      );
      const apiLayer =
        path === "account"
          ? HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
              Layer.provide(clientHandlers),
            )
          : HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.pwa)).pipe(
              Layer.provide(
                RelayHttpApi.pwaApi.pipe(
                  Layer.provide(layerTestLimiter),
                  Layer.provide(NodeCryptoLayer.layer),
                  Layer.provide(deps),
                ),
              ),
            );
      return Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(apiLayer.pipe(Layer.provide(HttpServer.layerServices)), {
              disableLogger: true,
            }),
          ),
          (app) => Effect.promise(() => app.dispose()),
        );
        const urlPath = path === "account" ? "client" : "pwa";
        const response = yield* Effect.promise(() =>
          app.handler(
            new Request(
              `https://relay.example.test/v1/${urlPath}/web-push/subscriptions/${subscription.id}/test`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer fixture-token",
                  "content-type": "application/json",
                },
                ...(path === "anonymous" ? { body: JSON.stringify({ installation }) } : {}),
              },
            ),
          ),
        );
        expect(response.status).toBe(acceptance === "failed" ? 500 : 200);
        if (acceptance !== "failed")
          expect(yield* Effect.promise(() => response.json())).toEqual({
            ok: acceptance === "accepted",
          });
        expect(jobs).toEqual(
          acceptance === "missing"
            ? []
            : [
                {
                  kind: "test",
                  userId: subscription.userId,
                  subscriptionId: subscription.id,
                  subscriptionIncarnationId: subscription.incarnationId,
                },
              ],
        );
      }).pipe(Effect.scoped);
    },
  );
});
