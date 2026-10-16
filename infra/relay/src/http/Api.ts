import { anonymousPwaAllowed } from "../agentActivity/anonymousPwaPolicy.ts";
import { sql as drizzleSql } from "drizzle-orm";
import * as Base64Url from "effect/encoding/Base64Url";
import type { PublicRelayOperation } from "./publicRelayPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as PublicRelayRateLimits from "./PublicRelayRateLimits.ts";
import { inspectBoundedJwt, assertPublicSpki } from "./publicRelayInputBounds.ts";
import {
  publicRelayBounds,
  publicRelayHeaderFailure,
  isRelayHookRequest,
  isRelayHookTraceRequest,
  relayTracePathDecodeFails,
  relayHookTraceUrl,
} from "./publicRelayPolicy.ts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as HttpObservability from "@t3tools/shared/httpObservability";

import {
  RelayApi,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayAccessTokenType,
  RelayDpopClientAuth,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
  RelayAuthInvalidError,
  type RelayAuthInvalidReason,
  type RelayDpopFailureReason,
  RelayEnvironmentAuth,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayEnvironmentPrincipal,
  type RelayEnvironmentConnectRequest,
  type RelayManagedEndpointOrigin,
  RelayManagedEndpointRecoveryProofPayload,
  type RelayDpopAccessTokenScope,
  RelayInternalError,
  RelayRateLimitExceededError,
  RelayServiceUnavailableError,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";

import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as RelayConfiguration from "../Config.ts";
import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as ManagedEndpointLifecycle from "../environments/ManagedEndpointLifecycle.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as WebPushSubscriptions from "../agentActivity/WebPushSubscriptions.ts";
import * as WebPushDeliveryQueue from "../agentActivity/WebPushDeliveryQueue.ts";
import {
  hasExpectedClerkAudience,
  verifyRelayClientBearerToken,
  verifyRelaySessionBearerToken,
} from "../auth/ClerkClientAuth.ts";
import { withSpanAttributes } from "../observability.ts";

export { verifyRelayClientBearerToken } from "../auth/ClerkClientAuth.ts";
import { isRelayHookPath } from "../hooks/HookForwarder.ts";
import * as RelayDb from "../db.ts";

// Delegated thread IDs carry escaped command provenance and exceed the router's
// default 100-character path parameter limit. Match the environment server.
export const RELAY_HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

const decodeManagedTunnelRecoveryProof = Schema.decodeUnknownEffect(
  RelayManagedEndpointRecoveryProofPayload,
);

const appendRelayCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        pragma: "no-cache",
      }),
    ),
);

const appendRelayDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    response.status === 401
      ? HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")
      : response,
  ),
);

const appendRelayTraceContextResponseHeader = Effect.gen(function* () {
  const span = yield* Effect.currentParentSpan;
  if (span._tag !== "Span") {
    return;
  }
  const traceparent = HttpTraceContext.toHeaders(span).traceparent;
  if (traceparent === undefined) {
    return;
  }
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "traceparent", traceparent)),
  );
}).pipe(Effect.ignore);

/** Hook-aware outer CORS; pre-response headers also cover deadlines and early errors. */
export const relayCors = Effect.fnUntraced(function* <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (isRelayHookPath(request.url) || isRelayHookRequest(request.method, request.url))
    return yield* httpEffect;
  yield* appendRelayCredentialResponseHeaders;
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "traceparent,www-authenticate,retry-after",
        ...(response.status === 429 ? { "retry-after": "60" } : {}),
        ...(request.method === "OPTIONS"
          ? {
              "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
              "access-control-allow-headers": "authorization,b3,traceparent,content-type,dpop",
              "access-control-max-age": "86400",
            }
          : {}),
      }),
    ),
  );
  return yield* httpEffect;
});

// Compatibility for existing route fixtures. Production uses the callable outer wrapper.
export const layerCors = HttpRouter.middleware(
  <E, R>(httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    relayCors(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return request.method === "OPTIONS" &&
          !isRelayHookPath(request.url) &&
          !isRelayHookRequest(request.method, request.url)
          ? HttpServerResponse.empty({ status: 204 })
          : yield* httpEffect;
      }),
    ),
  { global: true },
);

export const layerNotFoundRoute = HttpRouter.add(
  "*",
  "/*",
  HttpServerResponse.empty({ status: 404 }),
);

export const layerDocsRedirectRoute = HttpRouter.add(
  "GET",
  "/",
  HttpServerResponse.redirect("/docs"),
);

// Shorter than the mobile client's 10s request timeout on purpose: when a
// request hangs (e.g. a stuck upstream query), the client would otherwise
// abort first, the invocation would die with the request span still open, and
// the batched spans would never export — leaving no server-side trace at all.
export const RELAY_REQUEST_DEADLINE_MS = 9_000;
// Linking/unlinking owns several short database transactions around Cloudflare
// tunnel and DNS calls. Give that bounded setup room to finish before the
// corresponding client's 50s timeout, without extending ordinary API requests.
export const RELAY_ENVIRONMENT_LINK_DEADLINE_MS = 45_000;
/**
 * Webhook forwarding reads a body of up to 1 MiB, waits up to the upstream
 * timeout, and may then hold the request, so it needs more room than an API
 * call; cutting it off before the hold would drop a request it should keep.
 */
export const RELAY_HOOK_REQUEST_DEADLINE_MS = 25_000;

export const relayRequestDeadline = <A, E, R>(
  httpEffect: Effect.Effect<A, E, HttpServerRequest.HttpServerRequest | R>,
  deadlineMs = RELAY_REQUEST_DEADLINE_MS,
) =>
  httpEffect.pipe(
    Effect.timeoutOption(Duration.millis(deadlineMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* Effect.logError("relay request exceeded deadline", {
              "http.method": request.method,
              "http.url": request.url,
              "relay.request.deadline_ms": deadlineMs,
            });
            yield* Effect.annotateCurrentSpan({
              "relay.request.deadline_exceeded": true,
            });
            return HttpServerResponse.jsonUnsafe(
              { error: "relay_request_deadline_exceeded" },
              { status: 504 },
            );
          }),
        onSome: (value: A) => Effect.succeed<A | HttpServerResponse.HttpServerResponse>(value),
      }),
    ),
  );

const SENDER_TRACE_HEADER = /^(traceparent|tracestate|b3|x-b3-.*)$/i;

export const traceRelayHttpRequest = <E, R>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const oversized =
      request.url.length > publicRelayBounds.urlCharacters ||
      request.originalUrl.length > publicRelayBounds.urlCharacters ||
      publicRelayHeaderFailure(request.headers);
    const traceHeaders = oversized
      ? Headers.fromInput({ host: "relay.invalid" })
      : Headers.removeMany(
          request.headers,
          Object.keys(request.headers).filter((name) =>
            /^(cf-connecting-ip|cf-connecting-ipv6|cf-pseudo-ipv4|x-forwarded-for|x-real-ip|forwarded|true-client-ip|x-client-ip)$/i.test(
              name,
            ),
          ),
        );
    const safeTraceRequest = request.modify({
      ...(oversized || relayTracePathDecodeFails(request.url)
        ? { url: "/__relay_rejected_request__" }
        : isRelayHookTraceRequest(request.url)
          ? { url: relayHookTraceUrl(request.method, request.url) }
          : {}),
      headers: traceHeaders,
      remoteAddress: Option.none(),
    });
    if (!isRelayHookPath(request.url) && !isRelayHookRequest(request.method, request.url)) {
      const path = request.url.split("?", 1)[0] ?? "";
      const environmentLinkMutation =
        (request.method === "POST" && path === "/v1/client/environment-links") ||
        (request.method === "DELETE" && /^\/v1\/client\/environment-links\/[^/]+$/.test(path));
      return yield* HttpMiddleware.tracer(
        appendRelayTraceContextResponseHeader.pipe(
          Effect.andThen(
            relayRequestDeadline(
              httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
              environmentLinkMutation
                ? RELAY_ENVIRONMENT_LINK_DEADLINE_MS
                : RELAY_REQUEST_DEADLINE_MS,
            ),
          ),
        ),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, safeTraceRequest),
        // The worker turns its own request span off; this one is ours.
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => false),
        // HttpMiddleware finalizes its span on the dispatcher; do not close a request-scoped exporter first.
        Effect.ensuring(Effect.yieldNow),
      );
    }
    // Hook URLs carry a secret token: the tracer and deadline log see a redacted
    // request, while the route itself still receives the original. A webhook
    // sender's trace context is dropped, so it cannot pick the trace our relay
    // and environment spans land in.
    const redacted = safeTraceRequest.modify({
      url: oversized
        ? "/__relay_rejected_request__"
        : relayHookTraceUrl(request.method, request.url),
      headers: Headers.removeMany(
        traceHeaders,
        Object.keys(request.headers).filter((name) => SENDER_TRACE_HEADER.test(name)),
      ),
    });
    return yield* HttpMiddleware.tracer(
      appendRelayTraceContextResponseHeader.pipe(
        Effect.andThen(
          relayRequestDeadline(
            httpEffect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
            RELAY_HOOK_REQUEST_DEADLINE_MS,
          ),
        ),
      ),
    ).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, redacted),
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => false),
      Effect.ensuring(Effect.yieldNow),
    );
  });

const layerWebhookHeaderRedaction = Layer.effect(
  Headers.CurrentRedactedNames,
  Effect.map(Headers.CurrentRedactedNames, (names) => [
    ...names,
    /signature/i,
    /token/i,
    /secret/i,
    /key/i,
    /auth/i,
  ]),
);

export const traceRelayHttpRequestWith = <E, R, LayerError, LayerRequirements>(
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | R
  >,
  tracerLayer: Layer.Layer<never, LayerError, LayerRequirements>,
) =>
  traceRelayHttpRequest(httpEffect).pipe(
    Effect.provide(
      Layer.merge(
        tracerLayer,
        layerWebhookHeaderRedaction.pipe(Layer.provide(HttpObservability.layer)),
      ),
    ),
  );

export const withoutCapturedRequestContext = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const context = fiber.context;
    // Workers build routes during the first fetch. HttpApiBuilder retains its
    // build context, so a captured request would override the bounded request
    // supplied for each call and reread the already-consumed ingress body.
    fiber.setContext(
      Context.omit(
        Tracer.ParentSpan,
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.ParsedSearchParams,
        HttpRouter.RouteContext,
      )(context),
    );
    return effect.pipe(Effect.ensuring(Effect.sync(() => fiber.setContext(context))));
  });

export const layerClientAuth = Layer.effect(
  RelayClientAuth,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    return {
      clientBearer: Effect.fn("relay.auth.client.bearer")(function* (httpEffect, { credential }) {
        const token = readHttpAuthorizationCredential(credential);
        const verified = yield* verifyRelayClientBearerToken(config, token).pipe(
          Effect.tapError((error) =>
            Effect.annotateCurrentSpan(
              "relay.auth.clerk_verification_failure",
              clerkVerificationFailureReason(error.cause),
            ),
          ),
          Effect.catch(() => relayAuthInvalidError("invalid_bearer")),
        );
        if (!verified.sub) {
          yield* Effect.annotateCurrentSpan({
            "relay.auth.clerk_verification_failure": "missing_subject",
          });
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": verified.mode,
          "relay.auth.subject": verified.sub,
        });

        return yield* httpEffect.pipe(
          withSpanAttributes({ "user.id": verified.sub }),
          Effect.provideService(RelayClientPrincipal, {
            userId: verified.sub,
            token,
          }),
        );
      }),
    };
  }),
);

export const layerEnvironmentAuth = Layer.effect(
  RelayEnvironmentAuth,
  Effect.gen(function* () {
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    return {
      environmentBearer: Effect.fn("relay.auth.environment.bearer")(function* (
        httpEffect,
        { credential },
      ) {
        const token = readHttpAuthorizationCredential(credential);
        const principal = yield* credentials.authenticate(token).pipe(
          Effect.catchTags({
            EnvironmentCredentialAuthenticatePersistenceError: () =>
              relayInternalErrorResponse("persistence_failed"),
          }),
        );
        if (principal._tag === "None") {
          return yield* relayAuthInvalidError("not_authorized");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "environment_credential",
        });
        return yield* httpEffect.pipe(
          withSpanAttributes({
            "relay.environment_id": principal.value.environmentId,
          }),
          Effect.provideService(RelayEnvironmentPrincipal, principal.value),
        );
      }),
    };
  }),
);

export const layerDpopClientAuth = Layer.effect(
  RelayDpopClientAuth,
  Effect.gen(function* () {
    const relayTokens = yield* RelayTokens.RelayTokens;
    return {
      relayDpop: Effect.fn("relay.auth.dpop_client")(function* (httpEffect, { credential }) {
        yield* appendRelayDpopChallengeHeader;
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!isDpopAuthorizationHeader(request.headers.authorization)) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        const token = readHttpAuthorizationCredential(credential);
        const now = yield* DateTime.now;
        const verified = yield* relayTokens.verifyDpopAccessToken({
          token,
          nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        });
        if (!verified) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "dpop",
          "relay.auth.subject": verified.sub,
        });
        return yield* httpEffect.pipe(
          withSpanAttributes({ "user.id": verified.sub }),
          Effect.provideService(RelayClientPrincipal, {
            userId: verified.sub,
            token,
            proofKeyThumbprint: verified.cnf.jkt,
            dpopScopes: verified.scope,
          }),
        );
      }),
    };
  }),
);

function isDpopAuthorizationHeader(value: string | undefined): boolean {
  return /^DPoP +/iu.test(value ?? "");
}

function readHttpAuthorizationCredential(credential: Redacted.Redacted<string>): string {
  // Effect beta.73 leaves the scheme separator in decoded HTTP credentials.
  return Redacted.value(credential).trimStart();
}

export const layerMetadataApi = HttpApiBuilder.group(
  RelayApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const settings = yield* RelayConfiguration.RelayConfiguration;
    const issuer = normalizeRelayIssuer(settings.relayIssuer);
    const scopes = [
      RelayEnvironmentConnectScope,
      RelayEnvironmentStatusScope,
      RelayMobileRegistrationScope,
    ] as const;
    return handlers
      .handle("authorizationServer", () =>
        Effect.succeed({
          issuer,
          token_endpoint: `${issuer}/v1/client/dpop-token`,
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:token-exchange"],
          token_endpoint_auth_methods_supported: ["none"],
          dpop_signing_alg_values_supported: ["ES256"],
          scopes_supported: scopes,
        }),
      )
      .handle("protectedResource", () =>
        Effect.succeed({
          resource: issuer,
          authorization_servers: [issuer],
          scopes_supported: scopes,
          dpop_bound_access_tokens_required: true,
          dpop_signing_alg_values_supported: ["ES256"],
        }),
      );
  }),
);

export const layerHealthApi = HttpApiBuilder.group(
  RelayApi,
  "health",
  Effect.fnUntraced(function* (handlers) {
    const db = yield* RelayDb.RelayDb;
    return handlers.handle(
      "health",
      Effect.fn("relay.api.health")(
        function* () {
          yield* db.execute(drizzleSql`SELECT 1`);
          return { ok: true, service: "relay" as const };
        },
        Effect.catch(() => relayInternalErrorResponse("database_unavailable")),
      ),
    );
  }),
);

export const revokeEnvironmentLinkRecord = Effect.fn(
  "relay.api.client.revokeEnvironmentLinkRecord",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  const lifecycle = yield* ManagedEndpointLifecycle.ManagedEndpointLifecycle;
  return (yield* lifecycle.revokeAndRequestCleanup(input)).revoked;
});

export const unlinkEnvironmentRecord = Effect.fn("relay.api.client.unlinkEnvironmentRecord")(
  function* (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly managedEndpointNamespace?: string | undefined;
  }) {
    const lifecycle = yield* ManagedEndpointLifecycle.ManagedEndpointLifecycle;
    const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const captured = yield* lifecycle.revokeAndRequestCleanup(input);
    const unlinked = captured.revoked;
    const endpointKey =
      captured.tunnelName && input.managedEndpointNamespace
        ? HeldHooks.endpointKeyForTunnelName(input.managedEndpointNamespace, captured.tunnelName)
        : null;
    if (endpointKey !== null) {
      const inbox = yield* HookInbox.HookInbox;
      yield* inbox.clear({ endpointKey }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear held webhook requests", {
            environmentId: input.environmentId,
            errorTag: error._tag,
          }),
        ),
      );
    }
    yield* managedEndpointProvider
      .deprovision({
        userId: input.userId,
        environmentId: input.environmentId,
        target: captured.target,
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Managed endpoint cleanup after unlink failed", {
            environmentId: input.environmentId,
            errorTag: error._tag,
          }),
        ),
        Effect.ignore,
      );
    return unlinked;
  },
);

type EnvironmentTunnelRecoveryProofInput = {
  readonly proof: string;
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
} & (
  | {
      readonly action: "register";
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }
  | { readonly action: "recover"; readonly origin: RelayManagedEndpointOrigin }
);

export const verifyEnvironmentTunnelRecoveryProof = Effect.fn(
  "relay.api.server.verifyEnvironmentTunnelRecoveryProof",
)(function* (input: EnvironmentTunnelRecoveryProofInput) {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const now = yield* DateTime.now;
  yield* Effect.try({
    try: () => {
      inspectBoundedJwt(input.proof);
      assertPublicSpki(input.environmentPublicKey);
    },
    catch: () => new HttpApiError.Unauthorized({}),
  });
  const verified = yield* verifyRelayJwt({
    publicKey: input.environmentPublicKey,
    token: input.proof,
    typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
    issuer: `t3-env:${input.environmentId}`,
    audience: normalizeRelayIssuer(config.relayIssuer),
    nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
  }).pipe(
    Effect.flatMap(decodeManagedTunnelRecoveryProof),
    Effect.mapError(() => new HttpApiError.Unauthorized({})),
  );

  if (
    verified.environmentId !== input.environmentId ||
    verified.sub !== input.environmentId ||
    verified.cloudUserId !== input.userId ||
    verified.action !== input.action
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
  if (input.action === "register") {
    if (
      verified.action !== "register" ||
      verified.tunnelId !== input.tunnelId ||
      verified.origin.localHttpHost !== input.origin.localHttpHost ||
      verified.origin.localHttpPort !== input.origin.localHttpPort
    ) {
      return yield* new HttpApiError.Unauthorized({});
    }
    return;
  }
  if (
    verified.action !== "recover" ||
    verified.origin.localHttpHost !== input.origin.localHttpHost ||
    verified.origin.localHttpPort !== input.origin.localHttpPort
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
});

export const registerEnvironmentTunnelRecovery = Effect.fn(
  "relay.api.server.registerEnvironmentTunnelRecovery",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly expectedLink?: EnvironmentLinks.RelayLinkedEnvironmentRecord;
  readonly tunnelId: string;
  readonly origin: RelayManagedEndpointOrigin;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const link =
    input.expectedLink ??
    (yield* links.getForUser({
      userId: input.userId,
      environmentId: input.environmentId,
    }));
  if (
    link === null ||
    link.environmentPublicKey !== input.environmentPublicKey ||
    link.endpoint.providerKind !== "cloudflare_tunnel"
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }
  const status = yield* managedEndpointProvider.reconcileOrigin({
    userId: input.userId,
    environmentId: input.environmentId,
    tunnelId: input.tunnelId,
    origin: input.origin,
    expectedLink: {
      environmentPublicKey: link.environmentPublicKey,
      expectedLinkIncarnationId: link.linkIncarnationId,
      endpoint: link.endpoint,
    },
  });
  if (status === "recovery_required") {
    return { status };
  }
  return { status };
});

export const recoverEnvironmentTunnelRecord = Effect.fn(
  "relay.api.server.recoverEnvironmentTunnelRecord",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
  readonly expectedLink?: EnvironmentLinks.RelayLinkedEnvironmentRecord;
  readonly origin: RelayManagedEndpointOrigin;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const link =
    input.expectedLink ??
    (yield* links.getForUser({
      userId: input.userId,
      environmentId: input.environmentId,
    }));
  if (
    link === null ||
    link.environmentPublicKey !== input.environmentPublicKey ||
    link.endpoint.providerKind !== "cloudflare_tunnel"
  ) {
    return yield* new HttpApiError.Unauthorized({});
  }

  const recovered = yield* managedEndpointProvider.provision({
    userId: input.userId,
    environmentId: input.environmentId,
    origin: input.origin,
    publication: {
      kind: "recover",
      environmentPublicKey: link.environmentPublicKey,
      expectedLinkIncarnationId: link.linkIncarnationId,
      endpoint: link.endpoint,
    },
  });
  return {
    endpoint: recovered.endpoint,
    endpointRuntime: recovered.runtime,
  };
});

export const layerMobileApi = HttpApiBuilder.group(
  RelayApi,
  "mobile",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const registrations = yield* MobileRegistrations.MobileRegistrations;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "registerDevice",
        Effect.fn("relay.api.mobile.registerDevice")(function* (args) {
          const { payload } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
            operation: "registerDevice",
            userId,
          }).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
          );
          return yield* registrations.registerDevice({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "registerLiveActivity",
        Effect.fn("relay.api.mobile.registerLiveActivity")(function* (args) {
          const { payload } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
            operation: "registerLiveActivity",
            userId,
          }).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
          );
          return yield* registrations.registerLiveActivity({ userId, payload });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "getAgentActivitySnapshot",
        Effect.fn("relay.api.mobile.getAgentActivitySnapshot")(function* () {
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
            operation: "getAgentActivitySnapshot",
            userId,
          }).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
          );
          return yield* registrations.getAgentActivitySnapshot({ userId });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      )
      .handle(
        "unregisterDevice",
        Effect.fn("relay.api.mobile.unregisterDevice")(function* (args) {
          const { params } = args;
          const { userId, token } = yield* RelayClientPrincipal;
          const proofKeyThumbprint = yield* requireDpopPrincipalScope("mobile:registration");
          yield* requireDpopThumbprint(proofKeyThumbprint, {
            expectedAccessToken: token,
            operation: "unregisterDevice",
            userId,
          }).pipe(
            Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
            Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
          );
          return yield* registrations.unregisterDevice({ userId, deviceId: params.deviceId });
        }, mapRelayCommonApiErrors("invalid_dpop")),
      );
  }),
);

export const layerClientApi = HttpApiBuilder.group(
  RelayApi,
  "client",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const crypto = yield* Crypto.Crypto;
    const relayTokens = yield* RelayTokens.RelayTokens;
    const linker = yield* EnvironmentLinker.EnvironmentLinker;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const devices = yield* Devices.Devices;
    const webPushSubscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
    const webPushDeliveryQueue = yield* WebPushDeliveryQueue.WebPushDeliveryQueue;
    return handlers
      .handle(
        "listEnvironments",
        Effect.fn("relay.api.client.listEnvironments")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("listEnvironments", { kind: "user", userId });
          const environments = yield* links.listForUser({ userId });
          return { environments };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listDevices",
        Effect.fn("relay.api.client.listDevices")(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("listDevices", { kind: "user", userId });
          const registered = yield* devices.listForUser({ userId });
          return {
            devices: registered.flatMap((device) =>
              device.platform === "ios" && device.iosMajorVersion !== null
                ? [{ ...device, platform: "ios" as const, iosMajorVersion: device.iosMajorVersion }]
                : [],
            ),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "listDevicesV2",
        Effect.fn("relay.api.client.listDevicesV2")(function* () {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("listDevicesV2", { kind: "user", userId });
          return { devices: yield* devices.listForUser({ userId }) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "getWebPushConfig",
        Effect.fn("relay.api.client.getWebPushConfig")(function* () {
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("getWebPushConfig", { kind: "user", userId });
          if (!config.webPush) return yield* relayInternalErrorResponse("upstream_unavailable");
          const { publicKey } = config.webPush;
          return { applicationServerKey: publicKey };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "registerWebPushSubscription",
        Effect.fn("relay.api.client.registerWebPushSubscription")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("registerWebPushSubscription", { kind: "user", userId });
          return yield* webPushSubscriptions
            .register({ userId, payload: args.payload })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "unregisterWebPushSubscription",
        Effect.fn("relay.api.client.unregisterWebPushSubscription")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("unregisterWebPushSubscription", { kind: "user", userId });
          return {
            ok: yield* webPushSubscriptions
              .remove({
                userId,
                subscriptionId: args.params.subscriptionId,
              })
              .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error"))),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "testWebPushSubscription",
        Effect.fn("relay.api.client.testWebPushSubscription")(function* (args) {
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("testWebPushSubscription", { kind: "user", userId });
          const subscription = yield* webPushSubscriptions
            .get({
              userId,
              subscriptionId: args.params.subscriptionId,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          if (subscription === null) return { ok: false };
          const result = yield* webPushDeliveryQueue
            .enqueue({
              userId,
              subscriptionId: subscription.id,
              kind: "test",
              subscriptionIncarnationId: subscription.incarnationId,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          return { ok: result.ok && result.queued === true };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "linkEnvironment",
        Effect.fn("relay.api.client.linkEnvironment")(
          function* (args) {
            const { payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            const { userId } = yield* RelayClientPrincipal;
            yield* limiter.admit("linkEnvironment", { kind: "user", userId });
            const result = yield* linker.link({ userId, request: payload }).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Relay environment link failed", {
                  failure: relayLinkFailureStages(error),
                }),
              ),
            );
            return {
              ok: true,
              cloudUserId: userId,
              environmentId: result.environmentId,
              endpoint: result.endpoint,
              endpointRuntime: result.endpointRuntime,
              relayIssuer: config.relayIssuer,
              environmentCredential: result.environmentCredential,
              cloudMintPublicKey: config.cloudMintPublicKey,
            };
          },
          mapErrorTags({
            EnvironmentLinkProofExpired: (_error, traceId) =>
              new RelayEnvironmentLinkProofExpiredError({
                code: "environment_link_proof_expired",
                traceId,
              }),
            EnvironmentLinkProofInvalid: (linkError, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: linkError.reason,
                traceId,
              }),
            ManagedEndpointProvisioningNotConfigured: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_not_configured",
                traceId,
              }),
            ManagedEndpointProvisioningFailed: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_provisioning_failed",
                traceId,
              }),
            ManagedEndpointOriginNotAllowed: (_error, traceId) =>
              new RelayEnvironmentLinkProofInvalidError({
                code: "environment_link_proof_invalid",
                reason: "origin_not_allowed",
                traceId,
              }),
            ManagedTunnelLimitExceeded: (limitError, traceId) =>
              new RelayEnvironmentLinkLimitExceededError({
                code: "environment_link_limit_exceeded",
                maxTunnels: limitError.maxTunnels,
                traceId,
              }),
            EnvironmentLinkUpsertPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "link_persistence_failed",
                traceId,
              }),
            ManagedEndpointLifecyclePersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkUnavailableError({
                code: "environment_link_unavailable",
                reason: "managed_endpoint_provisioning_failed",
                traceId,
              }),
            DpopProofReplayPersistenceError: (_error, traceId) =>
              new RelayEnvironmentLinkFailedError({
                code: "environment_link_failed",
                reason: "replay_persistence_failed",
                traceId,
              }),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "createEnvironmentLinkChallenge",
        Effect.fn("relay.api.client.createEnvironmentLinkChallenge")(function* (args) {
          yield* appendRelayCredentialResponseHeaders;
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("createEnvironmentLinkChallenge", { kind: "user", userId });
          const now = yield* DateTime.now;
          const expiresAt = DateTime.add(now, { minutes: 5 });
          const jti = yield* crypto
            .randomUUIDv4()
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          const challenge = yield* relayTokens
            .issueLinkChallenge({
              userId,
              request: args.payload,
              jti,
              issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
              expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          return { challenge, expiresAt: DateTime.formatIso(expiresAt) };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "unlinkEnvironment",
        Effect.fn("relay.api.client.unlinkEnvironment")(function* (args) {
          const { params } = args;
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("unlinkEnvironment", { kind: "user", userId });
          const unlinked = yield* unlinkEnvironmentRecord({
            userId,
            environmentId: params.environmentId,
            managedEndpointNamespace: config.managedEndpointNamespace,
          }).pipe(
            Effect.catchTags({
              ManagedEndpointLifecyclePersistenceError: () =>
                relayInternalErrorResponse("upstream_unavailable"),
            }),
          );
          return { ok: unlinked };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "releaseEnvironmentTunnel",
        Effect.fn("relay.api.client.releaseEnvironmentTunnel")(function* (args) {
          const { params } = args;
          const { userId } = yield* RelayClientPrincipal;
          yield* limiter.admit("releaseEnvironmentTunnel", { kind: "user", userId });
          // ok mirrors whether the connector token is now dead: false means a
          // concurrent provision kept the recorded tunnel alive, so the caller
          // must not discard its runtime config.
          const released = yield* managedEndpointProvider
            .release({
              userId,
              environmentId: params.environmentId,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("upstream_unavailable")));
          return { ok: released };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const layerTokenApi = HttpApiBuilder.group(
  RelayApi,
  "token",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const crypto = yield* Crypto.Crypto;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    const relayTokens = yield* RelayTokens.RelayTokens;
    return handlers.handle(
      "exchangeDpopAccessToken",
      Effect.fn("relay.api.token.exchangeDpopAccessToken")(function* (args) {
        yield* appendRelayCredentialResponseHeaders;
        const issuer = normalizeRelayIssuer(config.relayIssuer);
        const requestedScopes = relayTokens.resolveDpopAccessTokenScopes({
          clientId: args.payload.client_id,
          scope: args.payload.scope,
        });
        yield* Effect.annotateCurrentSpan({
          "relay.auth.mode": "clerk_bearer_token_exchange",
          "relay.oauth.client_id": args.payload.client_id,
          "relay.oauth.scopes": args.payload.scope,
        });
        if (args.payload.resource !== issuer || requestedScopes === null) {
          return yield* new HttpApiError.Unauthorized({});
        }

        const verified = yield* verifyRelaySessionBearerToken(
          config,
          args.payload.subject_token,
        ).pipe(Effect.catch(() => relayAuthInvalidError("invalid_bearer")));
        if (
          !verified.sub ||
          verified.sub.length > 191 ||
          !hasExpectedClerkAudience(verified.aud, config.clerkJwtAudience)
        ) {
          return yield* relayAuthInvalidError("invalid_bearer");
        }
        const proofKeyThumbprint = yield* requireDpopProof({
          operation: "exchangeDpopAccessToken",
          userId: verified.sub,
        }).pipe(
          Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
          Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
        );
        const now = yield* DateTime.now;
        const expiresAt = DateTime.addDuration(now, RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL);
        const jti = yield* crypto
          .randomUUIDv4()
          .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
        return {
          access_token: yield* relayTokens
            .issueDpopAccessToken({
              userId: verified.sub,
              proofKeyThumbprint,
              jti,
              issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
              expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
              clientId: args.payload.client_id,
              scopes: requestedScopes,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error"))),
          issued_token_type: RelayAccessTokenType,
          token_type: "DPoP" as const,
          expires_in: Duration.toSeconds(RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL),
          scope: encodeOAuthScope(requestedScopes),
        };
      }, mapRelayCommonApiErrors("invalid_dpop")),
    );
  }),
);

export const layerDpopClientApi = HttpApiBuilder.group(
  RelayApi,
  "dpopClient",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const connector = yield* EnvironmentConnector.EnvironmentConnector;
    const dpopProofs = yield* DpopProofs.DpopProofReplay;
    return handlers
      .handle(
        "connectEnvironment",
        Effect.fn("relay.api.dpopClient.connectEnvironment")(
          function* (args) {
            const { params, payload } = args;
            yield* appendRelayCredentialResponseHeaders;
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:connect");
            const requestedThumbprint = resolveConnectClientKeyThumbprint(payload);
            if (!requestedThumbprint || requestedThumbprint !== proofKeyThumbprint) {
              return yield* new HttpApiError.Unauthorized({});
            }
            const clientProofKeyThumbprint = yield* requireDpopThumbprint(proofKeyThumbprint, {
              expectedAccessToken: token,
              operation: "connectEnvironment",
              userId,
            }).pipe(
              Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
              Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
            );
            return yield* connector.connect({
              userId,
              environmentId: params.environmentId,
              clientProofKeyThumbprint,
              ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                reason: error.reason,
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      )
      .handle(
        "getEnvironmentStatus",
        Effect.fn("relay.api.dpopClient.getEnvironmentStatus")(
          function* (args) {
            const { params } = args;
            const { userId, token } = yield* RelayClientPrincipal;
            const proofKeyThumbprint = yield* requireDpopPrincipalScope("environment:status");
            yield* requireDpopThumbprint(proofKeyThumbprint, {
              expectedAccessToken: token,
              operation: "getEnvironmentStatus",
              userId,
            }).pipe(
              Effect.provideService(DpopProofs.DpopProofReplay, dpopProofs),
              Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
            );
            return yield* connector.status({
              userId,
              environmentId: params.environmentId,
            });
          },
          mapRelayCommonApiErrors("invalid_dpop"),
          mapErrorTags({
            EnvironmentConnectNotAuthorized: (error, traceId) =>
              new RelayEnvironmentConnectNotAuthorizedError({
                code: "environment_connect_not_authorized",
                reason: error.reason,
                traceId,
              }),
            EnvironmentMintRequestFailed: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_request_failed",
                traceId,
              }),
            EnvironmentMintRequestTimedOut: (_error, traceId) =>
              new RelayEnvironmentEndpointTimedOutError({
                code: "environment_endpoint_timed_out",
                traceId,
              }),
            EnvironmentMintResponseInvalid: (_error, traceId) =>
              new RelayEnvironmentEndpointUnavailableError({
                code: "environment_endpoint_unavailable",
                reason: "endpoint_response_invalid",
                traceId,
              }),
          }),
        ),
      );
  }),
);

export const layerServerApi = HttpApiBuilder.group(
  RelayApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const crypto = yield* Crypto.Crypto;
    const admitEnvironment = (
      operation: PublicRelayOperation,
      environmentId: string,
      environmentPublicKey: string,
    ) =>
      environmentAdmissionSubject(crypto, environmentId, environmentPublicKey).pipe(
        Effect.flatMap((subject) => limiter.admit(operation, subject)),
      );
    const admitOwners = (
      operation: PublicRelayOperation,
      owners: ReadonlyArray<{ readonly userId: string }>,
    ) =>
      Effect.forEach(
        [...new Set(owners.map((owner) => owner.userId))],
        (userId) => limiter.admit(operation, { kind: "user", userId }),
        { discard: true },
      );
    const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
    const publishSignatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
    const heldHooks = yield* HeldHooks.HeldHooks;
    const requireOwnEnvironment = (environmentId: string) =>
      Effect.gen(function* () {
        const principal = yield* RelayEnvironmentPrincipal;
        if (principal.environmentId !== environmentId) {
          return yield* new HttpApiError.Unauthorized({});
        }
      });
    const activityHandlers = handlers.handle(
      "publishAgentActivity",
      Effect.fn("relay.api.server.publishAgentActivity")(
        function* (args) {
          const { params, payload } = args;
          const principal = yield* RelayEnvironmentPrincipal;
          if (principal.environmentId !== params.environmentId) {
            return yield* new HttpApiError.Unauthorized({});
          }
          const proof = yield* publishSignatures.verifyStateless({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            request: payload,
          });
          const selectedDeliveryUsers = yield* links.listDeliveryUsersForEnvironment({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
          });
          const deliveryUsers = [
            ...new Map(selectedDeliveryUsers.map((row) => [row.userId, row])).values(),
          ];
          yield* admitEnvironment(
            "publishAgentActivity",
            params.environmentId,
            principal.environmentPublicKey,
          );
          yield* admitOwners("publishAgentActivity", deliveryUsers);
          yield* publishSignatures.consumeVerified(proof);
          return yield* publisher.publishToRecipients({
            deliveryUsers,
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            threadId: params.threadId,
            state: payload.state,
          });
        },
        mapErrorTags({
          EnvironmentPublishPublicKeyMissing: (_error, traceId) =>
            new RelayAuthInvalidError({
              code: "auth_invalid",
              reason: "not_authorized",
              traceId,
            }),
          EnvironmentPublishSignatureExpired: (_error, traceId) =>
            new RelayAgentActivityPublishProofExpiredError({
              code: "agent_activity_publish_proof_expired",
              traceId,
            }),
          EnvironmentPublishSignatureInvalid: (error, traceId) =>
            new RelayAgentActivityPublishProofInvalidError({
              code: "agent_activity_publish_proof_invalid",
              reason: error.reason,
              traceId,
            }),
          DpopProofReplayPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
          ApnsDeliveryJobQueuePayloadInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobLiveActivityAggregateMissing: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobLiveActivityNotificationUnexpected: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobPushNotificationMissing: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobPushNotificationAggregateUnexpected: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobCreatedAtInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobExpiresAtInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobTimeWindowInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobTimeWindowTooLong: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobSignatureInvalid: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobExpired: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryJobClaimInFlight: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId,
            }),
          ApnsDeliveryQueueSendError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
          FcmDeliveryError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
          WebPushDeliveryQueueError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
          WebPushSubscriptionPersistenceError: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "persistence_failed",
              traceId,
            }),
        }),
        mapRelayCommonApiErrors("not_authorized"),
      ),
    );

    return activityHandlers
      .handle(
        "registerManagedEndpointRecovery",
        Effect.fn("relay.api.server.registerManagedEndpointRecovery")(
          function* ({ params, payload }) {
            const principal = yield* RelayEnvironmentPrincipal;
            if (principal.environmentId !== params.environmentId) {
              return yield* new HttpApiError.Unauthorized({});
            }
            yield* admitEnvironment(
              "registerManagedEndpointRecovery",
              params.environmentId,
              principal.environmentPublicKey,
            );
            yield* verifyEnvironmentTunnelRecoveryProof({
              action: "register",
              proof: payload.proof,
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              tunnelId: payload.tunnelId,
              origin: payload.origin,
            });
            const [owner] = yield* links.findActiveManagedForEnvironment({
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              userId: payload.cloudUserId,
            });
            if (
              !owner ||
              owner.userId !== payload.cloudUserId ||
              owner.environmentPublicKey !== principal.environmentPublicKey ||
              owner.endpoint.providerKind !== "cloudflare_tunnel"
            )
              return yield* new HttpApiError.Unauthorized({});
            yield* limiter.admit("registerManagedEndpointRecovery", {
              kind: "user",
              userId: owner.userId,
            });
            yield* appendRelayCredentialResponseHeaders;
            return yield* registerEnvironmentTunnelRecovery({
              userId: owner.userId,
              expectedLink: owner,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              tunnelId: payload.tunnelId,
              origin: payload.origin,
            });
          },
          Effect.catchTags({
            ManagedEndpointOriginNotAllowed: () => Effect.fail(new HttpApiError.Unauthorized({})),
            ManagedEndpointProvisioningNotConfigured: () => relayUnavailableResponse(),
            ManagedEndpointProvisioningFailed: () => relayUnavailableResponse(),
            ManagedTunnelLimitExceeded: (error) =>
              currentTraceId.pipe(
                Effect.flatMap((traceId) =>
                  Effect.fail(
                    new RelayEnvironmentLinkLimitExceededError({
                      code: "environment_link_limit_exceeded",
                      maxTunnels: error.maxTunnels,
                      traceId,
                    }),
                  ),
                ),
              ),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "recoverManagedEndpoint",
        Effect.fn("relay.api.server.recoverManagedEndpoint")(
          function* ({ params, payload }) {
            const principal = yield* RelayEnvironmentPrincipal;
            if (principal.environmentId !== params.environmentId) {
              return yield* new HttpApiError.Unauthorized({});
            }
            yield* admitEnvironment(
              "recoverManagedEndpoint",
              params.environmentId,
              principal.environmentPublicKey,
            );
            yield* verifyEnvironmentTunnelRecoveryProof({
              action: "recover",
              proof: payload.proof,
              userId: payload.cloudUserId,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              origin: payload.origin,
            });
            const [owner] = yield* links.findActiveManagedForEnvironment({
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              userId: payload.cloudUserId,
            });
            if (
              !owner ||
              owner.userId !== payload.cloudUserId ||
              owner.environmentPublicKey !== principal.environmentPublicKey ||
              owner.endpoint.providerKind !== "cloudflare_tunnel"
            )
              return yield* new HttpApiError.Unauthorized({});
            yield* limiter.admit("recoverManagedEndpoint", { kind: "user", userId: owner.userId });
            yield* appendRelayCredentialResponseHeaders;
            return yield* recoverEnvironmentTunnelRecord({
              userId: owner.userId,
              expectedLink: owner,
              environmentId: params.environmentId,
              environmentPublicKey: principal.environmentPublicKey,
              origin: payload.origin,
            });
          },
          Effect.catchTags({
            ManagedEndpointOriginNotAllowed: () => Effect.fail(new HttpApiError.Unauthorized({})),
            ManagedEndpointProvisioningNotConfigured: () => relayUnavailableResponse(),
            ManagedEndpointProvisioningFailed: () => relayUnavailableResponse(),
            ManagedTunnelLimitExceeded: (error) =>
              currentTraceId.pipe(
                Effect.flatMap((traceId) =>
                  Effect.fail(
                    new RelayEnvironmentLinkLimitExceededError({
                      code: "environment_link_limit_exceeded",
                      maxTunnels: error.maxTunnels,
                      traceId,
                    }),
                  ),
                ),
              ),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "updateLinkPreferences",
        Effect.fn("relay.api.server.updateLinkPreferences")(function* ({ params, payload }) {
          yield* requireOwnEnvironment(params.environmentId);
          const principal = yield* RelayEnvironmentPrincipal;
          const admittedLinks = yield* links.listActiveForEnvironment({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
          });
          yield* admitEnvironment(
            "updateLinkPreferences",
            params.environmentId,
            principal.environmentPublicKey,
          );
          yield* admitOwners("updateLinkPreferences", admittedLinks);
          yield* heldHooks.setHoldWhileOfflineForLinks({
            links: admittedLinks,
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
            holdWebhooksWhileOffline: payload.holdWebhooksWhileOffline,
          });
          return payload;
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "wakeHeldHooks",
        Effect.fn("relay.api.server.wakeHeldHooks")(function* ({ params }) {
          yield* requireOwnEnvironment(params.environmentId);
          const principal = yield* RelayEnvironmentPrincipal;
          const activeLinks = yield* links.listActiveForEnvironment({
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
          });
          const admittedLinks = activeLinks.filter(
            (link) =>
              link.managedTunnelsEnabled && link.endpoint.providerKind === "cloudflare_tunnel",
          );
          yield* admitEnvironment(
            "wakeHeldHooks",
            params.environmentId,
            principal.environmentPublicKey,
          );
          yield* admitOwners("wakeHeldHooks", admittedLinks);
          const pending = yield* heldHooks.wakeForLinks({
            links: admittedLinks,
            environmentId: params.environmentId,
            environmentPublicKey: principal.environmentPublicKey,
          });
          return { pending };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

export const pwaApi = HttpApiBuilder.group(
  RelayApi,
  "pwa",
  Effect.fnUntraced(function* (handlers) {
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const crypto = yield* Crypto.Crypto;
    const anonymousAllowed = yield* anonymousPwaAllowed;
    const config = yield* RelayConfiguration.RelayConfiguration;
    const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
    const queue = yield* WebPushDeliveryQueue.WebPushDeliveryQueue;
    const publishSignatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
    return handlers
      .handle(
        "getPwaWebPushConfig",
        Effect.fn("relay.api.pwa.get_web_push_config")(function* () {
          if (!anonymousAllowed) return yield* relayInternalErrorResponse("upstream_unavailable");
          if (!config.webPush) return yield* relayInternalErrorResponse("upstream_unavailable");
          return { applicationServerKey: config.webPush.publicKey };
        }),
      )
      .handle(
        "publishPwaAgentActivity",
        Effect.fn("relay.api.pwa.publish_agent_activity")(
          function* (args) {
            if (!anonymousAllowed) return yield* relayInternalErrorResponse("upstream_unavailable");
            const { params, payload } = args;
            const proof = yield* publishSignatures.verifyStateless({
              environmentId: params.environmentId,
              environmentPublicKey: payload.environmentPublicKey,
              threadId: params.threadId,
              request: { state: payload.state, proof: payload.proof },
            });
            const subject = yield* environmentAdmissionSubject(
              crypto,
              params.environmentId,
              payload.environmentPublicKey,
            );
            yield* limiter.admit("publishPwaAgentActivity", subject);
            yield* publishSignatures.consumeVerified(proof);
            // This anonymous route is deliberately separate from the account
            // relay projection. It advances only per-installation baselines and
            // does not retain thread activity when nobody installed this PWA.
            const notifications = yield* subscriptions
              .transitionEnvironment({ environmentId: params.environmentId, state: payload.state })
              .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
            const deliveries = yield* Effect.forEach(
              notifications,
              (notification) =>
                queue
                  .enqueue({
                    kind: "activity",
                    userId: notification.subscription.userId,
                    subscriptionId: notification.subscription.id,
                    subscriptionIncarnationId: notification.subscription.incarnationId,
                    provenance: {
                      ...notification.source,
                      environmentId: params.environmentId,
                      environmentPublicKey: payload.environmentPublicKey,
                      linkIncarnationId: null,
                    },
                    eventId: notification.eventId,
                    showProjectAndThreadNames: notification.showProjectAndThreadNames,
                  })
                  .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error"))),
              { concurrency: 4 },
            );
            return { ok: true, deliveries };
          },
          mapErrorTags({
            EnvironmentPublishPublicKeyMissing: (_error, traceId) =>
              new RelayAgentActivityPublishProofInvalidError({
                code: "agent_activity_publish_proof_invalid",
                reason: "invalid_signature_or_payload",
                traceId,
              }),
            EnvironmentPublishSignatureExpired: (_error, traceId) =>
              new RelayAgentActivityPublishProofExpiredError({
                code: "agent_activity_publish_proof_expired",
                traceId,
              }),
            EnvironmentPublishSignatureInvalid: (error, traceId) =>
              new RelayAgentActivityPublishProofInvalidError({
                code: "agent_activity_publish_proof_invalid",
                reason: error.reason,
                traceId,
              }),
            DpopProofReplayPersistenceError: (_error, traceId) =>
              new RelayInternalError({
                code: "internal_error",
                reason: "persistence_failed",
                traceId,
              }),
          }),
          mapRelayCommonApiErrors("not_authorized"),
        ),
      )
      .handle(
        "registerPwaWebPushSubscription",
        Effect.fn("relay.api.pwa.register_web_push_subscription")(function* (args) {
          if (!anonymousAllowed) return yield* relayInternalErrorResponse("upstream_unavailable");
          return yield* subscriptions.registerPwaPublic({ payload: args.payload }).pipe(
            Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
            Effect.catchTags({
              WebPushSubscriptionPersistenceError: () =>
                relayInternalErrorResponse("internal_error"),
              AnonymousPwaUnavailable: () => relayUnavailableResponse(),
            }),
          );
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "removePwaWebPushSubscription",
        Effect.fn("relay.api.pwa.remove_web_push_subscription")(function* (args) {
          return {
            ok: yield* subscriptions
              .removePwaPublic({
                subscriptionId: args.params.subscriptionId,
                installationId: args.payload.installation.installationId,
                installationSecret: args.payload.installation.installationSecret,
              })
              .pipe(
                Effect.provideService(PublicRelayRateLimits.PublicRelayRateLimits, limiter),
                Effect.catchTags({
                  WebPushSubscriptionPersistenceError: () =>
                    relayInternalErrorResponse("internal_error"),
                }),
              ),
          };
        }, mapRelayCommonApiErrors("not_authorized")),
      )
      .handle(
        "testPwaWebPushSubscription",
        Effect.fn("relay.api.pwa.test_web_push_subscription")(function* (args) {
          if (!anonymousAllowed) return yield* relayInternalErrorResponse("upstream_unavailable");
          const subscription = yield* subscriptions
            .getPwa({
              subscriptionId: args.params.subscriptionId,
              installationId: args.payload.installation.installationId,
              installationSecret: args.payload.installation.installationSecret,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          if (!subscription) return { ok: false };
          if (subscription.installationId === null) return { ok: false };
          yield* limiter.admit("testPwaWebPushSubscription", {
            kind: "installation",
            installationId: subscription.installationId,
          });
          const result = yield* queue
            .enqueue({
              userId: subscription.userId,
              subscriptionId: subscription.id,
              kind: "test",
              subscriptionIncarnationId: subscription.incarnationId,
            })
            .pipe(Effect.catch(() => relayInternalErrorResponse("internal_error")));
          return { ok: result.ok && result.queued === true };
        }, mapRelayCommonApiErrors("not_authorized")),
      );
  }),
);

const isHttpUnauthorized = Schema.is(HttpApiError.Unauthorized);
const isDpopProofRejected = Schema.is(DpopProofs.DpopProofRejected);

const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const RelayCommonPersistenceError = Schema.Union([
  Devices.DeviceRegistrationPersistenceError,
  Devices.DeviceUnregistrationPersistenceError,
  Devices.DeviceListPersistenceError,
  LiveActivities.LiveActivityRegistrationPersistenceError,
  EnvironmentLinks.EnvironmentLinkUserListPersistenceError,
  EnvironmentLinks.EnvironmentLinkListPersistenceError,
  EnvironmentLinks.EnvironmentLinkLookupPersistenceError,
  EnvironmentLinks.EnvironmentLinkRevokePersistenceError,
  ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError,
  EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError,
  EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError,
  DpopProofs.DpopProofReplayPersistenceError,
  LiveActivities.LiveActivityTargetListPersistenceError,
  AgentActivityRows.AgentActivityRowUpsertPersistenceError,
  AgentActivityRows.AgentActivityRowDeletePersistenceError,
  AgentActivityRows.AgentActivityRowListPersistenceError,
  LiveActivities.LiveActivityDeliveryMarkPersistenceError,
  DeliveryAttempts.DeliveryAttemptRecordPersistenceError,
  EnvironmentLinks.EnvironmentLinkEnvironmentLookupPersistenceError,
  HookInbox.HookInboxError,
]);
type RelayCommonPersistenceError = typeof RelayCommonPersistenceError.Type;
const isRelayCommonPersistenceError = Schema.is(RelayCommonPersistenceError);

type MapRelayCommonApiError<E> =
  | Exclude<
      E,
      | HttpApiError.Unauthorized
      | DpopProofs.DpopProofRejected
      | RelayCommonPersistenceError
      | PublicRelayRateLimits.PublicRelayRateLimited
      | PublicRelayRateLimits.PublicRelayLimiterUnavailable
    >
  | (Extract<E, HttpApiError.Unauthorized> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, DpopProofs.DpopProofRejected> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, RelayCommonPersistenceError> extends never ? never : RelayInternalError)
  | (Extract<E, PublicRelayRateLimits.PublicRelayRateLimited> extends never
      ? never
      : RelayRateLimitExceededError)
  | (Extract<E, PublicRelayRateLimits.PublicRelayLimiterUnavailable> extends never
      ? never
      : RelayServiceUnavailableError);

export function relayDpopFailureReason(
  code: DpopProofs.DpopProofFailureCode,
): RelayDpopFailureReason {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "replayed":
      return "replay";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
}

function relayUnavailableResponse() {
  return currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new RelayServiceUnavailableError({
          code: "relay_unavailable",
          reason: "internal",
          traceId,
        }),
      ),
    ),
  );
}

function environmentAdmissionSubject(
  crypto: Crypto.Crypto,
  environmentId: string,
  environmentPublicKey: string,
) {
  return crypto.digest("SHA-256", new TextEncoder().encode(environmentPublicKey)).pipe(
    Effect.map((digest): PublicRelayRateLimits.PublicRelaySubject => ({
      kind: "environment",
      environmentId,
      keyDigest: Base64Url.encode(digest),
    })),
    Effect.catch(() => relayInternalErrorResponse("internal_error")),
  );
}

function relayInternalErrorResponse(reason: RelayInternalError["reason"]) {
  return currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayInternalError({ code: "internal_error", reason, traceId })),
    ),
  );
}

export function relayPublicLimitError(
  error:
    | PublicRelayRateLimits.PublicRelayRateLimited
    | PublicRelayRateLimits.PublicRelayLimiterUnavailable,
  traceId: string,
) {
  return error._tag === "PublicRelayRateLimited"
    ? new RelayRateLimitExceededError({
        code: "relay_rate_limited",
        retryAfterSeconds: 60,
        traceId,
      })
    : new RelayServiceUnavailableError({ code: "relay_unavailable", reason: "internal", traceId });
}

const isPublicRelayRateLimited = Schema.is(PublicRelayRateLimits.PublicRelayRateLimited);
const isPublicRelayLimiterUnavailable = Schema.is(
  PublicRelayRateLimits.PublicRelayLimiterUnavailable,
);

export function mapRelayCommonApiErrors(authReason: RelayAuthInvalidReason) {
  const mapError = Effect.fnUntraced(function* <E>(error: E) {
    const traceId = yield* currentTraceId;
    if (isPublicRelayRateLimited(error) || isPublicRelayLimiterUnavailable(error))
      return yield* Effect.fail(relayPublicLimitError(error, traceId) as MapRelayCommonApiError<E>);
    if (isDpopProofRejected(error)) {
      yield* Effect.annotateCurrentSpan({
        "relay.dpop.failure_code": error.code,
      });
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop"
            ? { dpopFailureReason: relayDpopFailureReason(error.code) }
            : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isHttpUnauthorized(error)) {
      if (authReason === "invalid_dpop") {
        yield* Effect.annotateCurrentSpan({
          "relay.dpop.failure_code": "invalid_proof",
        });
      }
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop" ? { dpopFailureReason: "invalid_proof" } : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isRelayCommonPersistenceError(error)) {
      return yield* Effect.fail(
        new RelayInternalError({
          code: "internal_error",
          reason: "persistence_failed",
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }

    return yield* Effect.fail(error as MapRelayCommonApiError<E>);
  });

  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MapRelayCommonApiError<E>, R> => effect.pipe(Effect.catch(mapError));
}

type TaggedErrorTag<E> = Extract<E, { readonly _tag: string }>["_tag"];

type MapErrorTagCases<E> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
    traceId: string,
  ) => unknown;
};

type MappedTagError<Cases> = Cases[keyof Cases] extends (
  ...args: ReadonlyArray<never>
) => infer Error
  ? Error
  : never;

type CatchTagCases<E, Cases> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
  ) => Effect.Effect<never, MappedTagError<Cases>>;
} & (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never });

function relayLinkFailureStages(error: unknown) {
  const stages: Array<{ [key: string]: string | number }> = [];
  const fields = ["_tag", "name", "stage", "operation", "reason", "code"];
  let cause = error;
  for (let depth = 0; depth < 6 && typeof cause === "object" && cause !== null; depth++) {
    const stage: { [key: string]: string | number } = {};
    for (const field of fields) {
      if (!(field in cause)) continue;
      const value: unknown = Reflect.get(cause, field);
      if (typeof value === "string") stage[field] = value.slice(0, 160);
      else if (typeof value === "number") stage[field] = value;
    }
    stages.push(stage);
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return stages;
}

function mapErrorTags<
  E,
  Cases extends MapErrorTagCases<E> &
    (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never }),
>(cases: Cases) {
  const catchCases = Record.map(
    cases as Record.ReadonlyRecord<
      string,
      (error: never, traceId: string) => MappedTagError<Cases>
    >,
    (makeError) => (error: never) =>
      currentTraceId.pipe(Effect.flatMap((traceId) => Effect.fail(makeError(error, traceId)))),
  ) as CatchTagCases<E, Cases>;

  return <A, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>, R> =>
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
    Effect.catchTags(self, catchCases) as Effect.Effect<
      A,
      Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>,
      R
    >;
}

function resolveConnectClientKeyThumbprint(payload: RelayEnvironmentConnectRequest): string | null {
  const requestedThumbprint = payload.clientKeyThumbprint ?? payload.clientProofKeyThumbprint;
  if (!requestedThumbprint) {
    return null;
  }
  if (
    payload.clientKeyThumbprint &&
    payload.clientProofKeyThumbprint &&
    payload.clientKeyThumbprint !== payload.clientProofKeyThumbprint
  ) {
    return null;
  }
  return requestedThumbprint;
}

function safeAuthFailureReason(value: string): string {
  return /^[a-z0-9._-]+$/i.test(value) ? value : "unknown";
}

function clerkVerificationFailureReason(cause: unknown): string {
  if (
    cause instanceof Error &&
    (cause.message.startsWith("Invalid JWT audience claim ") ||
      cause.message.startsWith("Invalid JWT audience claim array "))
  ) {
    return "audience_mismatch";
  }
  if (typeof cause === "object" && cause !== null && "reason" in cause) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return safeAuthFailureReason(reason);
    }
  }
  if (cause instanceof Error && cause.name) {
    return safeAuthFailureReason(cause.name);
  }
  return "unknown";
}

const requireDpopPrincipalScope = Effect.fn("relay.api.require_dpop_principal_scope")(function* (
  scope: RelayDpopAccessTokenScope,
) {
  yield* Effect.annotateCurrentSpan({ "relay.dpop.required_scope": scope });
  const principal = yield* RelayClientPrincipal;
  if (!principal.proofKeyThumbprint || !principal.dpopScopes?.includes(scope)) {
    return yield* new HttpApiError.Unauthorized({});
  }
  return principal.proofKeyThumbprint;
});

const requireDpopThumbprint = Effect.fn("relay.api.require_dpop_thumbprint")(function* (
  expectedThumbprint: string,
  options: {
    readonly operation: PublicRelayOperation;
    readonly userId: string;
    readonly expectedAccessToken?: string;
  },
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  const proof = yield* dpopProofs.verify({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    expectedThumbprint,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
  const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
  yield* limiter.admit(options.operation, { kind: "user", userId: options.userId });
  return yield* dpopProofs.consumeVerified(proof);
});

const requireDpopProof = Effect.fn("relay.api.require_dpop_proof")(function* (options: {
  readonly operation: PublicRelayOperation;
  readonly userId: string;
  readonly expectedAccessToken?: string;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const now = yield* DateTime.now;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") {
    return yield* new HttpApiError.Unauthorized({});
  }
  const dpopProofs = yield* DpopProofs.DpopProofReplay;
  const proof = yield* dpopProofs.verify({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    now,
    ...(options?.expectedAccessToken ? { expectedAccessToken: options.expectedAccessToken } : {}),
  });
  const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
  yield* limiter.admit(options.operation, { kind: "user", userId: options.userId });
  return yield* dpopProofs.consumeVerified(proof);
});

const relayAuthInvalidError = Effect.fnUntraced(function* (reason: RelayAuthInvalidReason) {
  const traceId = yield* currentTraceId;
  yield* Effect.annotateCurrentSpan({
    "relay.trace_id": traceId,
    "relay.error.outbound_tag": "RelayAuthInvalidError",
    "relay.error.outbound_reason": reason,
  });
  return yield* new RelayAuthInvalidError({ code: "auth_invalid", reason, traceId });
});

const layerRelayHttpPlatform = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

/** Production and offline fixtures use the same router, docs, catch-all, and configuration. */
export const assembleRelayHttpRoutes = <A, E, R>(layerApp: Layer.Layer<A, E, R>) =>
  Layer.merge(
    Layer.mergeAll(
      HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(layerApp),
      ),
      HttpApiScalar.layer(RelayApi, { path: "/docs" }),
      layerDocsRedirectRoute,
    ).pipe(Layer.provide([Etag.layerWeak, layerRelayHttpPlatform])),
    layerNotFoundRoute,
  ).pipe(
    HttpRouter.toHttpEffect,
    Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG),
    withoutCapturedRequestContext,
  );
