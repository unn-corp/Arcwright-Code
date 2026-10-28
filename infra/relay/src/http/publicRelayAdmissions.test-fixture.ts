import { EnvironmentId } from "@t3tools/contracts";
import { type RelayDpopAccessTokenScope } from "@t3tools/contracts/relay";
import { computeDpopJwkThumbprint, computeDpopAccessTokenHash } from "@t3tools/shared/dpop";
import {
  RELAY_ACTIVITY_PUBLISH_TYP,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
} from "@t3tools/shared/relayJwt";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Redacted from "effect/Redacted";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { RelayApi } from "@t3tools/contracts/relay";
import {
  clerkKeys,
  relayKeys,
  signFixtureJwt,
  systemEpochSeconds,
  dpopKey,
  signDpop,
} from "./publicRelayProofs.test-fixture.ts";
import * as Api from "./Api.ts";
import * as Boundary from "./PublicRelayBoundary.ts";
import * as Limits from "./PublicRelayRateLimits.ts";
import { publicRelayOperations, type PublicRelayOperation } from "./publicRelayPolicy.ts";
import * as Configuration from "../Config.ts";
import * as Links from "../environments/EnvironmentLinks.ts";
import * as Linker from "../environments/EnvironmentLinker.ts";
import * as Connector from "../environments/EnvironmentConnector.ts";
import * as Credentials from "../environments/EnvironmentCredentials.ts";
import * as Allocations from "../environments/ManagedEndpointAllocations.ts";
import * as Lifecycle from "../environments/ManagedEndpointLifecycle.ts";
import * as Provider from "../environments/ManagedEndpointProvider.ts";
import * as Mobile from "../agentActivity/MobileRegistrations.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as Subscriptions from "../agentActivity/WebPushSubscriptions.ts";
import * as Queue from "../agentActivity/WebPushDeliveryQueue.ts";
import * as Tokens from "../auth/RelayTokens.ts";
import * as Dpop from "../auth/DpopProofs.ts";
import * as PublishProofs from "../environments/EnvironmentPublishSignatures.ts";
import * as Publisher from "../agentActivity/AgentActivityPublisher.ts";
import * as Rows from "../agentActivity/AgentActivityRows.ts";
import * as Live from "../agentActivity/LiveActivities.ts";
import * as Apns from "../agentActivity/ApnsDeliveries.ts";
import * as Fcm from "../agentActivity/FcmDeliveries.ts";
import * as Held from "../hooks/HeldHooks.ts";
import * as Inbox from "../hooks/HookInbox.ts";
import * as Db from "../db.ts";

const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const config = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("sk_test_fixture"),
  clerkPublishableKey: `pk_test_${btoa("clerk.example.test$")}`,
  clerkJwtAudience: "t3-code-relay",
  clerkAuthPolicy: {
    mode: "owned",
    issuer: "https://clerk.example.test",
    cliClientId: "fixture_cli",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("fixture-job-secret"),
  cloudMintPrivateKey: Redacted.make(relayKeys.privateKey),
  cloudMintPublicKey: relayKeys.publicKey,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: "fixture",
  webPush: {
    subject: "mailto:fixture@example.test",
    publicKey: "fixture",
    privateKey: Redacted.make("fixture"),
  },
} satisfies Configuration.RelayConfiguration["Service"];
export const preferences = {
  enabled: true,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  showProjectAndThreadNames: false,
};
export const subscriptionPayload = {
  endpoint: "https://push.example.test/fixture",
  keys: { p256dh: "key", auth: "auth" },
  preferences,
};
export const installation = {
  installationId: "installation-fixture",
  installationSecret: "secret-fixture",
};
export const counters = () => ({
  credentials: 0,
  owners: 0,
  business: 0,
  writes: 0,
  replay: 0,
  provider: 0,
  queues: 0,
  crypto: 0,
  uuid: 0,
  signing: 0,
  recipients: [] as string[],
  affected: [] as string[],
  allocationOwners: [] as string[],
});
export const owner = (
  userId = "user_verified",
  managed = true,
  environmentId = "env",
): Links.ActiveEnvironmentLinkRecord => ({
  userId,
  environmentId: EnvironmentId.make(environmentId),
  environmentPublicKey: relayKeys.publicKey,
  label: "Fixture",
  linkIncarnationId: `incarnation-${userId}`,
  linkedAt: "1970-01-01T00:00:00.000Z",
  endpoint: {
    httpBaseUrl: "https://0123456789abcdef.example.test/",
    wsBaseUrl: "wss://0123456789abcdef.example.test/ws",
    providerKind: managed ? "cloudflare_tunnel" : "manual",
  },
  managedTunnelsEnabled: managed,
  holdWebhooksWhileOffline: false,
});
export const clerkToken = (
  userId = "user_verified",
  issuer = config.clerkAuthPolicy.issuer,
  audience = config.clerkJwtAudience,
) => {
  const now = systemEpochSeconds();
  return signFixtureJwt(
    { iss: issuer, aud: audience, sub: userId, iat: now, nbf: now - 1, exp: now + 300 },
    clerkKeys.privateKey,
    "RS256",
  );
};
const unused = () => Effect.die("unexpected unrelated route");
const routes = Layer.mergeAll(
  Api.layerClientApi,
  Api.layerMobileApi,
  Api.layerTokenApi,
  Api.layerDpopClientApi,
  Api.layerServerApi,
  Api.pwaApi,
  HttpApiBuilder.group(RelayApi, "mobileTelemetry", (h) => h.handleRaw("ingest", unused)),
  HttpApiBuilder.group(RelayApi, "health", (h) => h.handleRaw("health", unused)),
  HttpApiBuilder.group(RelayApi, "metadata", (h) =>
    h.handleRaw("authorizationServer", unused).handleRaw("protectedResource", unused),
  ),
  HttpApiBuilder.group(RelayApi, "hooks", (h) =>
    h
      .handleRaw("forwardPost", unused)
      .handleRaw("forwardPut", unused)
      .handleRaw("forwardPatch", unused)
      .handleRaw("forwardGet", unused),
  ),
);
export const send = Effect.fn("publicRelayAdmissions.test-fixture.send")(function* <E, R>(
  endpoint: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  request: Request,
) {
  const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
  yield* HttpEffect.toHandled(endpoint, (_, response) => Deferred.succeed(sent, response)).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
    Effect.exit,
  );
  return HttpServerResponse.toWeb(yield* Deferred.await(sent));
});
export const fixture = Effect.fn("fixture")(function (input: {
  readonly admit: Limits.PublicRelayRateLimits["Service"]["admit"];
  readonly counts: ReturnType<typeof counters>;
  readonly owners?: () => ReadonlyArray<Links.ActiveEnvironmentLinkRecord>;
  readonly config?: Configuration.RelayConfiguration["Service"];
  readonly links?: Links.EnvironmentLinks["Service"];
  readonly subscriptions?: Subscriptions.WebPushSubscriptions["Service"];
  readonly provider?: Partial<Provider.ManagedEndpointProvider["Service"]>;
  readonly environmentPublicKey?: string;
}) {
  const counts = input.counts;
  const settings = input.config ?? config;
  const owners = input.owners ?? (() => [owner()]);
  const seen = new Set<string>();
  const replayDb = {
    insert: () => ({
      values: (value: { thumbprint: string; jti: string }) => ({
        onConflictDoNothing: () => ({
          returning: () =>
            Effect.sync(() => {
              counts.replay++;
              const id = `${value.thumbprint}:${value.jti}`;
              if (seen.has(id)) return [];
              seen.add(id);
              return [{ jti: value.jti }];
            }),
        }),
      }),
    }),
  } as unknown as Db.RelayDb["Service"];
  const layerCrypto = Layer.effect(
    Crypto.Crypto,
    Crypto.Crypto.pipe(
      Effect.map((base) => ({
        ...base,
        digest: (...args: Parameters<typeof base.digest>) =>
          base.digest(...args).pipe(Effect.tap(() => Effect.sync(() => counts.crypto++))),
        randomUUIDv4: ((options?: Parameters<Crypto.Crypto["randomUUIDv4"]>[0]) =>
          base
            .randomUUIDv4(options)
            .pipe(
              Effect.tap(() => Effect.sync(() => counts.uuid++)),
            )) as Crypto.Crypto["randomUUIDv4"],
      })),
    ),
  ).pipe(Layer.provide(NodeCrypto.layer));
  const layerTokens = Layer.effect(
    Tokens.RelayTokens,
    Effect.gen(function* () {
      const base = yield* Tokens.RelayTokens;
      return {
        ...base,
        issueLinkChallenge: Effect.fn("RelayTokens.issueLinkChallenge")(
          (args: Parameters<typeof base.issueLinkChallenge>[0]) =>
            Effect.sync(() => counts.signing++).pipe(Effect.andThen(base.issueLinkChallenge(args))),
        ),
        issueDpopAccessToken: Effect.fn("RelayTokens.issueDpopAccessToken")(
          (args: Parameters<typeof base.issueDpopAccessToken>[0]) =>
            Effect.sync(() => counts.signing++).pipe(
              Effect.andThen(base.issueDpopAccessToken(args)),
            ),
        ),
      };
    }),
  ).pipe(
    Layer.provide(
      Tokens.layer.pipe(Layer.provide(Configuration.layer(settings)), Layer.provide(layerCrypto)),
    ),
  );
  const linkLayer = input.links
    ? Layer.succeed(Links.EnvironmentLinks, input.links)
    : Layer.mock(Links.EnvironmentLinks, {
        listForUser: () =>
          Effect.sync(() => {
            counts.business++;
            return [];
          }),
        listDeliveryUsersForEnvironment: ({ environmentId, environmentPublicKey }) =>
          Effect.sync(() => {
            counts.owners++;
            return owners()
              .filter(
                (link) =>
                  link.environmentId === environmentId &&
                  link.environmentPublicKey === environmentPublicKey,
              )
              .map((link) => ({
                userId: link.userId,
                linkIncarnationId: link.linkIncarnationId,
                notificationsEnabled: true,
                liveActivitiesEnabled: true,
              }));
          }),
        listActiveForEnvironment: ({ environmentId, environmentPublicKey }) =>
          Effect.sync(() => {
            counts.owners++;
            return owners().filter(
              (link) =>
                link.environmentId === environmentId &&
                link.environmentPublicKey === environmentPublicKey,
            );
          }),
        findActiveManagedForEnvironment: ({ environmentId, userId, environmentPublicKey }) =>
          Effect.sync(() => {
            counts.owners++;
            return owners().filter(
              (link) =>
                link.environmentId === environmentId &&
                link.managedTunnelsEnabled &&
                (userId === undefined || link.userId === userId) &&
                (environmentPublicKey === undefined ||
                  (link.environmentId === environmentId &&
                    link.environmentPublicKey === environmentPublicKey)),
            );
          }),
        getForUser: ({ userId }) =>
          Effect.sync(() => {
            counts.business++;
            return owners().find((link) => link.userId === userId) ?? null;
          }),
        setHoldWebhooksWhileOfflineForLinks: (args) =>
          Effect.sync(() => {
            counts.writes++;
            const current = args.links.filter((link) =>
              owners().some(
                (row) =>
                  row.userId === link.userId && row.linkIncarnationId === link.linkIncarnationId,
              ),
            );
            counts.affected.push(...current.map((row) => row.userId));
            return current;
          }),
      });
  const lower = Layer.mergeAll(
    layerCrypto,
    Configuration.layer(settings),
    layerTokens,
    linkLayer,
    Layer.succeed(Db.RelayDb, replayDb),
    Layer.mock(Credentials.EnvironmentCredentials, {
      authenticate: (token) =>
        Effect.sync(() => {
          counts.credentials++;
          return Option.some({
            credentialId: "credential-fixture",
            environmentId: token.slice("t3env_fixture:".length),
            environmentPublicKey: input.environmentPublicKey ?? relayKeys.publicKey,
          });
        }),
    }),
    Layer.mock(Linker.EnvironmentLinker, {
      link: () =>
        Effect.sync(() => {
          counts.provider++;
          return {
            environmentId: EnvironmentId.make("env"),
            endpoint: owner().endpoint,
            endpointRuntime: null,
            environmentCredential: "fixture-credential",
          };
        }),
    }),
    Layer.mock(Connector.EnvironmentConnector, {
      connect: () =>
        Effect.sync(() => {
          counts.business++;
          return {
            environmentId: EnvironmentId.make("env"),
            endpoint: owner().endpoint,
            credential: "fixture-session",
            expiresAt: "1970-01-01T00:05:00.000Z",
          };
        }),
      status: () =>
        Effect.sync(() => {
          counts.business++;
          return {
            environmentId: EnvironmentId.make("env"),
            endpoint: owner().endpoint,
            status: "online" as const,
            checkedAt: "1970-01-01T00:00:00.000Z",
          };
        }),
    }),
    Layer.mock(Lifecycle.ManagedEndpointLifecycle, {
      revokeAndRequestCleanup: () =>
        Effect.sync(() => {
          counts.writes++;
          return { revoked: false, target: null, tunnelName: null };
        }),
    }),
    Layer.mock(Provider.ManagedEndpointProvider, {
      release: () =>
        Effect.sync(() => {
          counts.provider++;
          return true;
        }),
      deprovision: () =>
        Effect.sync(() => {
          counts.provider++;
          return true;
        }),
      reconcileOrigin: () =>
        Effect.sync(() => {
          counts.provider++;
          return "ready" as const;
        }),
      provision: () =>
        Effect.sync(() => {
          counts.provider++;
          return {
            kind: "recovered" as const,
            endpoint: owner().endpoint,
            runtime: {
              providerKind: "cloudflare_tunnel" as const,
              connectorToken: "fixture-token",
              tunnelId: "fixture-tunnel",
            },
          };
        }),
      ...input.provider,
    }),
    Layer.mock(Allocations.ManagedEndpointAllocations, {
      get: ({ userId }) =>
        Effect.sync(() => {
          counts.allocationOwners.push(userId);
          return null;
        }),
    }),
    Layer.mock(Inbox.HookInbox, {
      clear: () =>
        Effect.sync(() => {
          counts.queues++;
        }),
      wake: () =>
        Effect.sync(() => {
          counts.queues++;
          return false;
        }),
    }),
    Layer.mock(Devices.Devices, {
      listForUser: () =>
        Effect.sync(() => {
          counts.business++;
          return [];
        }),
    }),
    input.subscriptions
      ? Layer.succeed(Subscriptions.WebPushSubscriptions, input.subscriptions)
      : Layer.mock(Subscriptions.WebPushSubscriptions, {
          register: () =>
            Effect.sync(() => {
              counts.writes++;
              return { subscriptionId: "subscription" };
            }),
          remove: () =>
            Effect.sync(() => {
              counts.writes++;
              return true;
            }),
          get: () =>
            Effect.sync(() => {
              counts.business++;
              return null;
            }),
          transition: () =>
            Effect.sync(() => {
              counts.writes++;
              return [];
            }),
          transitionEnvironment: () =>
            Effect.sync(() => {
              counts.writes++;
              return [];
            }),
        }),
    Layer.mock(Queue.WebPushDeliveryQueue, {
      enqueue: (args) =>
        Effect.sync(() => {
          counts.queues++;
          return {
            deviceId: args.subscriptionId,
            kind: "web_push_notification" as const,
            ok: true,
            queued: true,
            apnsStatus: null,
            apnsReason: null,
            apnsId: null,
          };
        }),
    }),
    Layer.mock(Rows.AgentActivityRows, {
      upsert: () =>
        Effect.sync(() => {
          counts.writes++;
        }),
      remove: () =>
        Effect.sync(() => {
          counts.writes++;
        }),
      listForUser: () =>
        Effect.sync(() => {
          counts.business++;
          return [];
        }),
    }),
    Layer.mock(Live.LiveActivities, {
      listTargets: ({ userId }) =>
        Effect.sync(() => {
          counts.business++;
          counts.recipients.push(userId);
          return [];
        }),
    }),
    Layer.mock(Apns.ApnsDeliveries, {}),
    Layer.mock(Fcm.FcmDeliveries, {}),
  );
  const replay = Dpop.layer.pipe(Layer.provide(lower));
  const business = Layer.mergeAll(
    PublishProofs.layer.pipe(Layer.provide(replay), Layer.provide(lower)),
    Publisher.layer.pipe(Layer.provide(lower)),
    Held.layer.pipe(Layer.provide(lower)),
    Layer.mock(Mobile.MobileRegistrations, {
      registerDevice: () =>
        Effect.sync(() => {
          counts.writes++;
          return { ok: true as const };
        }),
      registerLiveActivity: () =>
        Effect.sync(() => {
          counts.writes++;
          return { ok: true as const };
        }),
      unregisterDevice: () =>
        Effect.sync(() => {
          counts.writes++;
          return { ok: true as const };
        }),
      getAgentActivitySnapshot: () =>
        Effect.sync(() => {
          counts.business++;
          return { aggregate: null };
        }),
    }),
  );
  const dependencies = Layer.mergeAll(lower, replay, business);
  const app = routes.pipe(
    HttpRouter.provideRequest(dependencies),
    Layer.provideMerge(
      Layer.mergeAll(Api.layerClientAuth, Api.layerDpopClientAuth, Api.layerEnvironmentAuth).pipe(
        Layer.provide(dependencies),
      ),
    ),
    Layer.provideMerge(dependencies),
    Layer.provideMerge(NodeServices.layer),
  );
  return Boundary.assemblePublicRelayHttp(
    app,
    Layer.succeed(Limits.PublicRelayRateLimits, { admit: input.admit }),
  ).pipe(
    Effect.provide(HttpServer.layerServices),
    Effect.map((endpoint) =>
      endpoint.pipe(
        Effect.provideService(Limits.TrustedEdgeIdentity, { status: "available", ip: "192.0.2.4" }),
      ),
    ),
  );
});
let nextNonce = 0;
export const requestForOperation = Effect.fnUntraced(function* (
  operation: PublicRelayOperation,
  options: {
    readonly userId?: string;
    readonly environmentId?: string;
    readonly selector?: string;
    readonly key?: ReturnType<typeof dpopKey>;
    readonly dpopClaims?: Readonly<Record<string, unknown>>;
    readonly scopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly payload?: object;
    readonly proofOverride?: string;
  } = {},
) {
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  const userId = options.userId ?? "user_verified";
  const environmentId = options.environmentId ?? "env";
  const [method, template] = publicRelayOperations[operation];
  const url = `${config.relayIssuer}${template.replace(":environmentId", environmentId).replace(":threadId", "thread").replace(":deviceId", "device").replace(":subscriptionId", "subscription")}`;
  const nonce = `fixture-nonce-${nextNonce++}`;
  const key = options.key ?? dpopKey();
  const thumbprint = computeDpopJwkThumbprint(key.jwk);
  const scopes = options.scopes ?? [
    "environment:connect",
    "environment:status",
    "mobile:registration",
  ];
  const accessToken = yield* Effect.promise(() =>
    signFixtureJwt(
      {
        iss: config.relayIssuer,
        aud: config.relayIssuer,
        sub: userId,
        iat: now,
        exp: now + 300,
        jti: nonce,
        client_id: "t3-mobile",
        scope: scopes.join(" "),
        cnf: { jkt: thumbprint },
      },
      relayKeys.privateKey,
      "EdDSA",
      "t3-relay-dpop-access+jwt",
    ),
  );
  const dpopOps = new Set<PublicRelayOperation>([
    "connectEnvironment",
    "getEnvironmentStatus",
    "registerDevice",
    "registerLiveActivity",
    "getAgentActivitySnapshot",
    "unregisterDevice",
  ]);
  const proof =
    options.proofOverride ??
    (yield* Effect.promise(() =>
      signDpop(key, {
        htm: method,
        htu: url,
        jti: nonce,
        iat: now,
        ...(operation === "exchangeDpopAccessToken"
          ? {}
          : { ath: computeDpopAccessTokenHash(accessToken) }),
        ...options.dpopClaims,
      }),
    ));
  let payload: object | undefined;
  if (operation === "createEnvironmentLinkChallenge" || operation === "linkEnvironment")
    payload = {
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: true,
      ...(operation === "linkEnvironment" ? { proof: "fixture-proof" } : {}),
    };
  if (operation === "connectEnvironment")
    payload = { deviceId: nonce, clientProofKeyThumbprint: thumbprint };
  if (operation === "registerDevice")
    payload = {
      deviceId: nonce,
      label: "Android",
      platform: "android",
      androidApiLevel: 36,
      preferences: {
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    };
  if (operation === "registerLiveActivity")
    payload = { deviceId: nonce, activityPushToken: "activity-token" };
  if (operation === "registerWebPushSubscription") payload = subscriptionPayload;
  if (operation === "updateLinkPreferences") payload = { holdWebhooksWhileOffline: false };
  if (operation === "registerManagedEndpointRecovery" || operation === "recoverManagedEndpoint") {
    const action = operation === "registerManagedEndpointRecovery" ? "register" : "recover";
    const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };
    const cloudUserId = options.selector ?? userId;
    const claims = {
      iss: `t3-env:${environmentId}`,
      aud: config.relayIssuer,
      sub: environmentId,
      iat: now,
      exp: now + 300,
      jti: nonce,
      environmentId,
      cloudUserId,
      action,
      origin,
      ...(action === "register" ? { tunnelId: "fixture-tunnel" } : {}),
    };
    payload = {
      origin,
      cloudUserId,
      proof:
        options.proofOverride ??
        (yield* Effect.promise(() =>
          signFixtureJwt(claims, relayKeys.privateKey, "EdDSA", RELAY_MANAGED_TUNNEL_RECOVERY_TYP),
        )),
      ...(action === "register" ? { tunnelId: "fixture-tunnel" } : {}),
    };
  }
  if (operation === "publishAgentActivity" || operation === "publishPwaAgentActivity") {
    const state = null;
    payload = {
      state,
      proof:
        options.proofOverride ??
        (yield* Effect.promise(() =>
          signFixtureJwt(
            {
              iss: `t3-env:${environmentId}`,
              aud: config.relayIssuer,
              sub: environmentId,
              iat: now,
              exp: now + 300,
              jti: nonce,
              environmentId,
              threadId: "thread",
              state,
            },
            relayKeys.privateKey,
            "EdDSA",
            RELAY_ACTIVITY_PUBLISH_TYP,
          ),
        )),
      ...(operation === "publishPwaAgentActivity"
        ? { environmentPublicKey: relayKeys.publicKey }
        : {}),
    };
  }
  if (operation === "registerPwaWebPushSubscription")
    payload = { ...subscriptionPayload, environmentId, installation };
  if (operation === "removePwaWebPushSubscription" || operation === "testPwaWebPushSubscription")
    payload = { installation };
  if (operation === "exchangeDpopAccessToken")
    payload = {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: yield* Effect.promise(() => clerkToken(userId)),
      resource: config.relayIssuer,
      client_id: "t3-mobile",
      scope: scopes.join(" "),
    };
  payload = options.payload ?? payload;
  const form = operation === "exchangeDpopAccessToken";
  return new Request(url, {
    method,
    headers: {
      host: new URL(config.relayIssuer).host,
      "x-forwarded-proto": "https",
      authorization: dpopOps.has(operation)
        ? `DPoP ${accessToken}`
        : template.startsWith("/v1/environments/") && !dpopOps.has(operation)
          ? `Bearer t3env_fixture:${environmentId}`
          : `Bearer ${yield* Effect.promise(() => clerkToken(userId))}`,
      dpop: proof,
      origin: "https://client.example.test",
      ...(payload
        ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }
        : {}),
    },
    ...(payload
      ? {
          body: form
            ? new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)]))
            : yield* encodePayloadJson(payload),
        }
      : {}),
  });
});
