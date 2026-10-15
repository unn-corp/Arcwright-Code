import { describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import {
  RelayApi,
  RelayClientAuth,
  RelayDpopClientAuth,
  RelayEnvironmentAuth,
  RelayClientPrincipal,
  RelayEnvironmentPrincipal,
  RelayRequestHeadersTooLargeError,
} from "@t3tools/contracts/relay";
import { mapRelayCommonApiErrors } from "./Api.ts";
import {
  assemblePublicRelayHttp,
  withCloudflarePublicRelayIdentity,
} from "./PublicRelayBoundary.ts";
import * as RateLimits from "./PublicRelayRateLimits.ts";
import { canonicalEdgeIp, publicRelayOperations, publicRelayBuckets } from "./publicRelayPolicy.ts";

import { isBoundedJwt } from "./publicRelayInputBounds.ts";

const decodeHeadersTooLarge = Schema.decodeUnknownEffect(RelayRequestHeadersTooLargeError);

const encode = (value: string) => new TextEncoder().encode(value);
const counts = () => ({ auth: 0, business: 0, limiter: 0 });
const routeViews: HttpServerRequest.HttpServerRequest[] = [];
function fixtureRoutes(
  calls: ReturnType<typeof counts>,
  routedDenial = false,
  construction?: (
    limiter: Option.Option<RateLimits.PublicRelayRateLimits["Service"]>,
    identity: Option.Option<RateLimits.TrustedEdgeIdentity["Service"]>,
  ) => void,
  decodeChallengePayload = false,
) {
  const handle = ({ request }: { readonly request: HttpServerRequest.HttpServerRequest }) =>
    Effect.gen(function* () {
      calls.business++;
      routeViews.push(request);
      const text = yield* request.text.pipe(Effect.orDie);
      return HttpServerResponse.jsonUnsafe({
        text,
        method: request.method,
        url: request.url,
        absolute: request.originalUrl,
        header: request.headers["x-proxy-view"],
        remote: Option.getOrUndefined(request.remoteAddress),
        aborted: request.source instanceof Request ? request.source.signal.aborted : false,
      });
    });
  const auth = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.sync(() => {
      calls.auth++;
    }).pipe(Effect.andThen(effect));
  return Layer.mergeAll(
    HttpApiBuilder.group(RelayApi, "health", (handlers) =>
      Effect.gen(function* () {
        construction?.(
          yield* Effect.serviceOption(RateLimits.PublicRelayRateLimits),
          yield* Effect.serviceOption(RateLimits.TrustedEdgeIdentity),
        );
        return handlers.handleRaw("health", handle);
      }),
    ),
    HttpApiBuilder.group(RelayApi, "metadata", (handlers) =>
      handlers.handleRaw("authorizationServer", handle).handleRaw("protectedResource", handle),
    ),
    HttpApiBuilder.group(RelayApi, "mobile", (handlers) =>
      handlers
        .handleRaw("registerDevice", handle)
        .handleRaw("registerLiveActivity", handle)
        .handleRaw("getAgentActivitySnapshot", handle)
        .handleRaw("unregisterDevice", handle),
    ),
    HttpApiBuilder.group(RelayApi, "client", (handlers) =>
      handlers
        .handleRaw("listEnvironments", handle)
        .handleRaw("getWebPushConfig", handle)
        .handleRaw("registerWebPushSubscription", handle)
        .handleRaw("unregisterWebPushSubscription", handle)
        .handleRaw("testWebPushSubscription", handle)
        .handleRaw(
          "listDevices",
          routedDenial
            ? () =>
                Effect.fail(new RateLimits.PublicRelayRateLimited({ retryAfterSeconds: 60 })).pipe(
                  mapRelayCommonApiErrors("not_authorized"),
                )
            : handle,
        )
        .handleRaw("listDevicesV2", handle)
        .handleRaw("linkEnvironment", handle)
        .pipe((handlers) =>
          decodeChallengePayload
            ? handlers.handle("createEnvironmentLinkChallenge", ({ payload }) => {
                calls.business++;
                return Effect.succeed({
                  challenge: JSON.stringify(payload),
                  expiresAt: "2026-10-15T19:00:00.000Z",
                });
              })
            : handlers.handleRaw("createEnvironmentLinkChallenge", handle),
        )
        .handleRaw("unlinkEnvironment", handle)
        .handleRaw("releaseEnvironmentTunnel", handle),
    ),
    HttpApiBuilder.group(RelayApi, "token", (handlers) =>
      handlers.handleRaw("exchangeDpopAccessToken", handle),
    ),
    HttpApiBuilder.group(RelayApi, "dpopClient", (handlers) =>
      handlers.handleRaw("connectEnvironment", handle).handleRaw("getEnvironmentStatus", handle),
    ),
    HttpApiBuilder.group(RelayApi, "server", (handlers) =>
      handlers
        .handleRaw("registerManagedEndpointRecovery", handle)
        .handleRaw("recoverManagedEndpoint", handle)
        .handleRaw("publishAgentActivity", handle)
        .handleRaw("updateLinkPreferences", handle)
        .handleRaw("wakeHeldHooks", handle),
    ),
    HttpApiBuilder.group(RelayApi, "pwa", (handlers) =>
      handlers
        .handleRaw("getPwaWebPushConfig", handle)
        .handleRaw("publishPwaAgentActivity", handle)
        .handleRaw("registerPwaWebPushSubscription", handle)
        .handleRaw("removePwaWebPushSubscription", handle)
        .handleRaw("testPwaWebPushSubscription", handle),
    ),
    HttpApiBuilder.group(RelayApi, "hooks", (handlers) =>
      handlers
        .handleRaw("forwardPost", handle)
        .handleRaw("forwardPut", handle)
        .handleRaw("forwardPatch", handle)
        .handleRaw("forwardGet", handle),
    ),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(RelayClientAuth, {
          clientBearer: (effect) =>
            auth(effect).pipe(
              Effect.provideService(RelayClientPrincipal, {
                userId: "synthetic-user",
                token: "synthetic-token",
              }),
            ),
        }),
        Layer.succeed(RelayDpopClientAuth, {
          relayDpop: (effect) =>
            auth(effect).pipe(
              Effect.provideService(RelayClientPrincipal, {
                userId: "synthetic-user",
                token: "synthetic-token",
              }),
            ),
        }),
        Layer.succeed(RelayEnvironmentAuth, {
          environmentBearer: (effect) =>
            auth(effect).pipe(
              Effect.provideService(RelayEnvironmentPrincipal, {
                environmentId: "synthetic-env",
                environmentPublicKey: "synthetic-key",
              }),
            ),
        }),
      ),
    ),
  );
}
function rawRequest(
  body: Uint8Array[],
  options: {
    readonly headers?: Record<string, string>;
    readonly url?: string;
    readonly method?: string;
    readonly fail?: boolean;
    readonly hold?: boolean;
    readonly neverCancel?: boolean;
    readonly rejectCancel?: boolean;
    readonly signal?: AbortSignal;
    readonly onPull?: () => void;
  } = {},
) {
  let read = 0;
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read++;
        options.onPull?.();
        if (options.fail) {
          controller.error(new Error("synthetic read failure"));
          return;
        }
        if (body.length > 0) controller.enqueue(body.shift()!);
        else if (!options.hold) controller.close();
      },
      cancel() {
        cancelled++;
        return options.rejectCancel
          ? Promise.reject(new Error("synthetic cancellation failure"))
          : options.neverCancel
            ? new Promise<void>(() => {})
            : Promise.resolve();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(options.url ?? "https://relay.test/v1/client/environment-links", {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer bounded-fixture",
      dpop: "bounded-proof",
      ...options.headers,
    },
    body: stream,
    duplex: "half",
    ...(options.signal ? { signal: options.signal } : {}),
  } as RequestInit);
  return { request, read: () => read, cancelled: () => cancelled };
}
const expectUnreadBodyClosed = Effect.fnUntraced(function* (raw: ReturnType<typeof rawRequest>) {
  expect(raw.read()).toBe(0);
  expect(raw.cancelled()).toBe(1);
  expect(raw.request.bodyUsed).toBe(true);
  expect(raw.request.body?.locked).toBe(false);
  const reader = raw.request.body!.getReader();
  try {
    expect(yield* Effect.promise(() => reader.read())).toEqual({ done: true, value: undefined });
  } finally {
    reader.releaseLock();
  }
  expect(raw.read()).toBe(0);
  expect(raw.cancelled()).toBe(1);
  expect(raw.request.body?.locked).toBe(false);
});
const send = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  request: Request,
  view = HttpServerRequest.fromWeb(request),
) =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
    yield* HttpEffect.toHandled(effect, (_request, response) =>
      Deferred.succeed(sent, response),
    ).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, view),
      // The Cloudflare adapter disables its automatic span; the exported wrapper explicitly enables its own.
      Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
      Effect.exit,
    );
    const response = yield* Deferred.await(sent);
    return HttpServerResponse.toWeb(response, { withoutBody: request.method === "HEAD" });
  });
function withBoundary(
  calls: ReturnType<typeof counts>,
  admit: RateLimits.PublicRelayRateLimits["Service"]["admit"] = () => Effect.void,
  routedDenial = false,
  decodeChallengePayload = false,
) {
  return assemblePublicRelayHttp(
    fixtureRoutes(calls, routedDenial, undefined, decodeChallengePayload),
    Layer.succeed(RateLimits.PublicRelayRateLimits, {
      admit: (op, subject) => {
        calls.limiter++;
        return admit(op, subject);
      },
    }),
  ).pipe(
    Effect.provide(HttpServer.layerServices),
    Effect.map((endpoint) =>
      endpoint.pipe(
        Effect.provideService(RateLimits.TrustedEdgeIdentity, {
          status: "available",
          ip: "192.0.2.1",
        }),
      ),
    ),
  );
}

describe("production public relay boundary and route assembly", () => {
  it.effect("decodes a real client environment-link challenge after bounded body admission", () =>
    Effect.gen(function* () {
      const calls = counts();
      const payload = {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: true,
      };
      const request = new Request("https://relay.test/v1/client/environment-link-challenges", {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Workers construct the exported router in the first fetch's context.
      const endpoint = yield* withBoundary(calls, () => Effect.void, false, true).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
      const response = yield* send(endpoint, request);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        challenge: JSON.stringify(payload),
      });
      const nextPayload = { ...payload, managedTunnelsEnabled: false };
      const nextResponse = yield* send(
        endpoint,
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(nextPayload),
        }),
      );
      expect(nextResponse.status).toBe(200);
      expect(yield* Effect.promise(() => nextResponse.json())).toMatchObject({
        challenge: JSON.stringify(nextPayload),
      });
      expect(calls.business).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect.each([undefined, "0", "1", "65536"])(
    "counts actual65536/65537 bytes with CL %s",
    (declared) =>
      Effect.gen(function* () {
        const calls = counts();
        const endpoint = yield* withBoundary(calls);
        const json = '{"padding":"' + "x".repeat(65536 - 14) + '"}';
        expect(encode(json).byteLength).toBe(65536);
        const headers = declared === undefined ? {} : { "content-length": declared };
        const accepted = rawRequest([encode(json)], { headers });
        expect((yield* send(endpoint, accepted.request)).status).toBe(200);
        const rejected = rawRequest([encode(json + " ")], { headers, neverCancel: true });
        expect((yield* send(endpoint, rejected.request)).status).toBe(413);
        expect(rejected.cancelled()).toBe(1);
        expect(calls).toEqual({ auth: 1, business: 1, limiter: 2 });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { value: "65537", status: 413 },
    { value: "9".repeat(500), status: 413 },
    { value: "+1", status: 400 },
    { value: "-1", status: 400 },
    { value: "1e3", status: 400 },
    { value: "1,2", status: 400 },
    { value: "bad", status: 400 },
  ] as const)("rejects declared $value before reading/admission", ({ value, status }) =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const raw = rawRequest([encode("{}")], {
        headers: { "content-length": value },
        neverCancel: true,
      });
      const response = yield* send(endpoint, raw.request);
      expect(response.status).toBe(status);
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
      expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }).pipe(Effect.scoped),
  );

  it.effect.each([429, 503] as const)(
    "encodes/cancels early%d with zero downstream work",
    (status) =>
      Effect.gen(function* () {
        const calls = counts();
        const endpoint = yield* withBoundary(calls, () =>
          Effect.fail(
            status === 429
              ? new RateLimits.PublicRelayRateLimited({ retryAfterSeconds: 60 })
              : new RateLimits.PublicRelayLimiterUnavailable({}),
          ),
        );
        for (const [, [method, path]] of Object.entries(publicRelayOperations)) {
          const url = "https://relay.test" + path.replace(/:[^/]+/g, "synthetic-id");
          const raw = method === "GET" ? undefined : rawRequest([encode("{}")], { method, url });
          const response = yield* send(endpoint, raw?.request ?? new Request(url, { method }));
          expect(response.status).toBe(status);
          const value = yield* Effect.promise(() => response.json());
          expect(value).toMatchObject({
            _tag: status === 429 ? "RelayRateLimitExceededError" : "RelayServiceUnavailableError",
            code: status === 429 ? "relay_rate_limited" : "relay_unavailable",
            traceId: expect.any(String),
            ...(status === 429 ? { retryAfterSeconds: 60 } : { reason: "internal" }),
          });
          expect(response.headers.get("retry-after")).toBe(status === 429 ? "60" : null);
          expect(response.headers.get("www-authenticate")).toBeNull();
          expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
          expect(response.headers.get("traceparent")).toMatch(/^00-/);
          expect(response.headers.get("cache-control")).toBe("no-store");
          if (raw) {
            expect(raw.read()).toBe(0);
            expect(raw.cancelled()).toBe(1);
          }
        }
        expect(calls.auth).toBe(0);
        expect(calls.business).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["never", "reject"] as const)(
    "closes unread ingress when admission reaches the outer deadline with %s cancellation",
    (cancellation) =>
      Effect.gen(function* () {
        const calls = counts();
        const entered = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const endpoint = yield* withBoundary(calls, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        );
        const raw = rawRequest([encode("{}")], {
          neverCancel: cancellation === "never",
          rejectCancel: cancellation === "reject",
        });
        const add = vi.spyOn(raw.request.signal, "addEventListener");
        const remove = vi.spyOn(raw.request.signal, "removeEventListener");
        try {
          const fiber = yield* send(endpoint, raw.request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          expect(raw.read()).toBe(0);
          expect(raw.cancelled()).toBe(0);
          yield* TestClock.adjust("9 seconds");
          const response = yield* Fiber.join(fiber);
          yield* Deferred.await(stopped);
          expect(response.status).toBe(504);
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "relay_request_deadline_exceeded",
          });
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(response.headers.get("traceparent")).toMatch(/^00-/);
          yield* expectUnreadBodyClosed(raw);
          expect(calls).toEqual({ auth: 0, business: 0, limiter: 1 });
          const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
          expect(listener).toBeDefined();
          expect(remove).toHaveBeenCalledWith("abort", listener);
        } finally {
          add.mockRestore();
          remove.mockRestore();
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each(["never", "reject"] as const)(
    "closes unread ingress on explicit admission fiber interruption with %s cancellation",
    (cancellation) =>
      Effect.gen(function* () {
        const calls = counts();
        const entered = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const endpoint = yield* withBoundary(calls, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        );
        const raw = rawRequest([encode("{}")], {
          neverCancel: cancellation === "never",
          rejectCancel: cancellation === "reject",
        });
        const fiber = yield* send(endpoint.pipe(Effect.interruptible), raw.request).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(stopped);
        const exit = fiber.pollUnsafe();
        expect(exit?._tag).toBe("Failure");
        if (exit?._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        yield* expectUnreadBodyClosed(raw);
        expect(calls).toEqual({ auth: 0, business: 0, limiter: 1 });
      }).pipe(Effect.scoped),
  );

  it.effect.each(
    ["before", "during"].flatMap((timing) =>
      ["never", "reject"].map((cancellation) => ({ timing, cancellation })),
    ),
  )(
    "closes unread ingress aborted $timing admission with $cancellation cancellation",
    ({ timing, cancellation }) =>
      Effect.gen(function* () {
        const calls = counts();
        const entered = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const endpoint = yield* withBoundary(calls, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        );
        const controller = new AbortController();
        const raw = rawRequest([encode("{}")], {
          signal: controller.signal,
          neverCancel: cancellation === "never",
          rejectCancel: cancellation === "reject",
        });
        const add = vi.spyOn(raw.request.signal, "addEventListener");
        const remove = vi.spyOn(raw.request.signal, "removeEventListener");
        try {
          if (timing === "before") controller.abort();
          const fiber = yield* send(endpoint, raw.request).pipe(Effect.forkChild);
          if (timing === "during") {
            yield* Deferred.await(entered);
            controller.abort();
          }
          const response = yield* Fiber.join(fiber);
          if (timing === "during") yield* Deferred.await(stopped);
          expect(response.status).toBe(400);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            _tag: "RelayRequestInvalidError",
            code: "relay_request_invalid",
          });
          yield* expectUnreadBodyClosed(raw);
          expect(calls).toEqual({
            auth: 0,
            business: 0,
            limiter: timing === "before" ? 0 : 1,
          });
          const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
          expect(listener).toBeDefined();
          expect(remove).toHaveBeenCalledWith("abort", listener);
        } finally {
          add.mockRestore();
          remove.mockRestore();
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "releases public ingress listeners after admitted EOF and retains the original signal",
    () =>
      Effect.gen(function* () {
        const calls = counts();
        const controller = new AbortController();
        const entered = yield* Deferred.make<void>();
        const admitted = yield* Deferred.make<void>();
        const endpoint = yield* withBoundary(calls, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(admitted))),
        );
        const raw = rawRequest([encode("{}")], { signal: controller.signal });
        const add = vi.spyOn(raw.request.signal, "addEventListener");
        const remove = vi.spyOn(raw.request.signal, "removeEventListener");
        try {
          const fiber = yield* send(endpoint, raw.request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const listeners = add.mock.calls.filter(([type]) => type === "abort");
          expect(listeners).toHaveLength(1);
          const listener = listeners[0]?.[1];
          expect(listener).toBeDefined();
          yield* Deferred.succeed(admitted, undefined);
          expect((yield* Fiber.join(fiber)).status).toBe(200);
          expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
          expect(raw.read()).toBe(2);
          expect(raw.cancelled()).toBe(0);
          expect(raw.request.body?.locked).toBe(false);
          const actual = routeViews.at(-1)!;
          expect(actual.source).toBeInstanceOf(Request);
          if (actual.source instanceof Request)
            expect(actual.source.signal).toBe(raw.request.signal);
          expect(remove).toHaveBeenCalledWith("abort", listener);
          controller.abort();
          expect(raw.cancelled()).toBe(0);
        } finally {
          add.mockRestore();
          remove.mockRestore();
        }
      }).pipe(Effect.scoped),
  );

  it.effect("leaves genuine raw-hook ingress ownership and listeners with its forwarder", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls, () => Effect.never);
      const raw = rawRequest([encode("{}")], {
        url: "https://relay.test/v1/hooks/endpoint/hook/private-token?sender=" + "q".repeat(9000),
      });
      const add = vi.spyOn(raw.request.signal, "addEventListener");
      try {
        const response = yield* send(endpoint, raw.request);
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(routeViews.at(-1)?.source).toBe(raw.request);
        expect(raw.cancelled()).toBe(0);
        expect(calls).toEqual({ auth: 0, business: 1, limiter: 0 });
        expect(add.mock.calls.filter(([type]) => type === "abort")).toHaveLength(0);
      } finally {
        add.mockRestore();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("bounds headers/URLs before trace capture and removes all raw IP attributes", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const raw = rawRequest([encode("{}")], {
        headers: { "x-too-big": "é".repeat(5000), "cf-connecting-ip": "192.0.2.99" },
      });
      const response = yield* send(endpoint, raw.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      expect(response.status).toBe(431);
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
      yield* Effect.yieldNow;
      expect(spans[0]?.attributes.get("client.address")).toBeUndefined();
      expect(spans[0]?.attributes.get("http.request.header.x-too-big")).toBeUndefined();
      expect(spans[0]?.attributes.get("url.path")).toBe("/__relay_rejected_request__");
      const admitted = new Request("https://relay.test/v1/pwa/web-push/config", {
        headers: {
          "cf-connecting-ip": "192.0.2.99",
          "x-forwarded-for": "198.51.100.99",
          "x-real-ip": "203.0.113.99",
          "x-captured-safe": "bounded",
        },
      });
      yield* send(
        endpoint,
        admitted,
        HttpServerRequest.fromWeb(admitted).modify({ remoteAddress: Option.some("192.0.2.99") }),
      ).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      yield* Effect.yieldNow;
      const admittedSpan = spans.at(-1)!;
      expect(admittedSpan.attributes.get("http.request.header.x-captured-safe")).toBe("bounded");
      expect(admittedSpan.attributes.get("client.address")).toBeUndefined();
      for (const name of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"])
        expect(admittedSpan.attributes.get(`http.request.header.${name}`)).toBeUndefined();
      const url = "https://relay.test/" + "x".repeat(8192);
      expect((yield* send(endpoint, new Request(url))).status).toBe(413);
      expect(calls).toEqual({ auth: 0, business: 1, limiter: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves exact originalURL/method/headers and proxy Effect view, including split UTF8",
    () =>
      Effect.gen(function* () {
        const calls = counts();
        const endpoint = yield* withBoundary(calls);
        const bytes = encode('{"value":"λ"}');
        const raw = rawRequest([bytes.subarray(0, 11), bytes.subarray(11)], {
          url: "https://relay.test/v1/client/environment-links?z=%2F#frag",
          headers: { "x-original": "value" },
        });
        const view = HttpServerRequest.fromWeb(raw.request).modify({
          headers: { ...HttpServerRequest.fromWeb(raw.request).headers, "x-proxy-view": "proxy" },
          remoteAddress: Option.some("192.0.2.88"),
        });
        const response = yield* send(endpoint, raw.request, view);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          text: '{"value":"λ"}',
          method: "POST",
          absolute: raw.request.url,
          url: view.url,
          header: "proxy",
          remote: "192.0.2.88",
          aborted: false,
        });
        const actual = routeViews.at(-1)!;
        expect(actual.source).toBeInstanceOf(Request);
        if (actual.source instanceof Request) {
          expect(actual.source.signal).toBe(raw.request.signal);
          expect([...actual.source.headers]).toEqual([...raw.request.headers]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "uses the installed router aliases and leaves HEAD/catch-all/static/OPTIONS exempt",
    () =>
      Effect.gen(function* () {
        const calls = counts();
        const endpoint = yield* withBoundary(calls, () =>
          Effect.fail(new RateLimits.PublicRelayRateLimited({ retryAfterSeconds: 60 })),
        );
        for (const path of [
          "/V1//CLIENT/DEVICES/",
          "/v1/client/%64evices",
          "/v1/client/devices;anything",
          "/v1/client/devices?x=1",
        ]) {
          expect((yield* send(endpoint, new Request("https://relay.test" + path))).status).toBe(
            429,
          );
        }
        const before = calls.limiter;
        for (const path of [
          "/",
          "/docs",
          "/openapi.json",
          "/.well-known/oauth-authorization-server",
          "/.well-known/oauth-protected-resource",
        ]) {
          expect(
            (yield* send(endpoint, new Request("https://relay.test" + path))).status,
          ).toBeLessThan(400);
        }
        // Catch-all resolves HEAD before installed GET fallback in this assembly.
        expect(
          (yield* send(
            endpoint,
            new Request("https://relay.test/v1/client/devices", { method: "HEAD" }),
          )).status,
        ).toBe(404);
        const unknown = rawRequest([new Uint8Array(65537)], {
          url: "https://relay.test/v1/no-route",
        });
        expect((yield* send(endpoint, unknown.request)).status).toBe(404);
        expect(unknown.read()).toBe(0);
        expect(unknown.cancelled()).toBe(1);
        for (const path of [
          "/v1/client/web-push/subscriptions",
          "/v1/pwa/web-push/subscriptions",
        ]) {
          const response = yield* send(
            endpoint,
            new Request("https://relay.test" + path, { method: "OPTIONS" }),
          );
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
          expect(response.headers.get("cache-control")).toBe("no-store");
        }
        expect(calls.limiter).toBe(before);
      }).pipe(Effect.scoped),
  );

  it.effect("cancels readfailure, abort and deadline and never enters auth", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const failed = rawRequest([], { fail: true });
      expect((yield* send(endpoint, failed.request)).status).toBe(400);
      const stalled = rawRequest([], { hold: true, neverCancel: true });
      const fiber = yield* send(endpoint, stalled.request).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("9 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe(504);
      expect(stalled.cancelled()).toBe(1);
      expect(calls.auth).toBe(0);
      expect(calls.business).toBe(0);
    }).pipe(Effect.scoped),
  );
  it.effect("header bytecaps and absentContentType JSONdepth checks happen before auth", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      for (const [name, length] of [
        ["authorization", 16385],
        ["dpop", 8193],
        ["content-type", 257],
        ["traceparent", 129],
        ["x-individual", 8193],
      ] as const) {
        const raw = rawRequest([encode("{}")], { headers: { [name]: "x".repeat(length) } });
        expect((yield* send(endpoint, raw.request)).status).toBe(431);
        expect(raw.read()).toBe(0);
        expect(raw.cancelled()).toBe(1);
      }
      const raw = rawRequest([encode("{}")], {
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`x-total-${index}`, "x".repeat(7000)]),
        ),
      });
      expect((yield* send(endpoint, raw.request)).status).toBe(431);
      expect(raw.read()).toBe(0);
      const nested = rawRequest([encode("[".repeat(33) + "0" + "]".repeat(33))]);
      nested.request.headers.delete("content-type");
      expect((yield* send(endpoint, nested.request)).status).toBe(400);
      expect(calls.auth).toBe(0);
      expect(calls.business).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the original reader on ingress abort without downstream work", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const started = yield* Deferred.make<void>();
      const controller = new AbortController();
      const raw = rawRequest([], {
        hold: true,
        signal: controller.signal,
        onPull: () => {
          Deferred.doneUnsafe(started, Effect.void);
        },
      });
      const fiber = yield* send(endpoint, raw.request).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      controller.abort();
      expect((yield* Fiber.join(fiber)).status).toBe(400);
      expect(raw.cancelled()).toBe(1);
      expect(calls.auth).toBe(0);
      expect(calls.business).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "boundedJSON depth/shape and boundedform constraints precede auth and accept padded65536 form",
    () =>
      Effect.gen(function* () {
        const calls = counts();
        const endpoint = yield* withBoundary(calls);
        const forms = [
          "subject_token=a&subject_token=b",
          Array.from({ length: 33 }, (_, i) => `k${i}=v`).join("&"),
        ];
        for (const text of forms) {
          const raw = rawRequest([encode(text)], {
            url: "https://relay.test/v1/client/dpop-token",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          });
          expect((yield* send(endpoint, raw.request)).status).toBe(400);
        }
        for (const text of [
          "[".repeat(33) + "0" + "]".repeat(33),
          JSON.stringify(Array.from({ length: 129 }, () => 0)),
          JSON.stringify(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), 0]))),
        ]) {
          expect((yield* send(endpoint, rawRequest([encode(text)]).request)).status).toBe(400);
        }
        expect(calls.auth).toBe(0);
        expect(calls.business).toBe(0);
        // Whitespace percent-decoding keeps the token field bounded while the complete wire form reaches64KiB.
        const prefix =
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=fixture&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Ajwt&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&resource=https%3A%2F%2Frelay.test&scope=environment%3Aconnect&client_id=t3-mobile";
        const padded = prefix + "&".repeat(65536 - prefix.length);
        expect(
          (yield* send(
            endpoint,
            rawRequest([encode(padded)], {
              url: "https://relay.test/v1/client/dpop-token",
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }).request,
          )).status,
        ).toBe(200);
        expect(calls.business).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("actual routed mapper encodes the same429 declaredunion with RetryAfter/CORS", () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls, undefined, true);
      const response = yield* send(
        endpoint,
        new Request("https://relay.test/v1/client/devices", {
          headers: { authorization: "Bearer fixture" },
        }),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "RelayRateLimitExceededError",
        code: "relay_rate_limited",
        retryAfterSeconds: 60,
        traceId: expect.any(String),
      });
      expect(calls).toEqual({ auth: 1, business: 0, limiter: 1 });
    }).pipe(Effect.scoped),
  );
});

describe("public policy and Cloudflare adapter", () => {
  it.effect(
    "provisions two distinct trusted IPs per event with one assembled runtime and limiter",
    () =>
      Effect.gen(function* () {
        const calls = counts();
        const keys: string[] = [];
        const counters = new Map<string, number>();
        const binding = {
          limit: ({ key }: { readonly key: string }) =>
            Effect.sync(() => {
              keys.push(key);
              const count = (counters.get(key) ?? 0) + 1;
              counters.set(key, count);
              return { success: count <= 1 };
            }),
        };
        const endpoint = yield* assemblePublicRelayHttp(
          fixtureRoutes(calls),
          RateLimits.layerCloudflare(
            { issuer: "https://relay.test", stage: "synthetic-stage" },
            { edge: binding },
          ),
        ).pipe(Effect.provide(HttpServer.layerServices));
        const shared = withCloudflarePublicRelayIdentity(endpoint);
        for (const [ip, status] of [
          ["192.0.2.1", 200],
          ["192.0.2.1", 429],
          ["192.0.2.2", 200],
        ] as const) {
          const ingress = new Request("https://relay.test/v1/pwa/web-push/config", {
            headers: { "cf-connecting-ip": ip },
          });
          const routeRequest = new Request(ingress.url, {
            headers: { "cf-connecting-ip": "198.51.100.99", "x-forwarded-for": "203.0.113.99" },
          });
          expect(
            (yield* send(shared, routeRequest).pipe(
              Effect.provideService(Cloudflare.Workers.Request, ingress),
            )).status,
          ).toBe(status);
        }
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).not.toBe(keys[2]);
        expect(
          keys.every((key) => !key.includes("198.51.100.99") && !key.includes("203.0.113.99")),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    null,
    "192.0.2.1,192.0.2.2",
    "[::1]",
    "fe80::1%eth0",
    "127.0.0.1:80",
    "not-an-ip",
  ])("fails closed for unavailable production identity %s without header fallbacks", (ip) =>
    Effect.gen(function* () {
      const calls = counts();
      const bounded = yield* assemblePublicRelayHttp(
        fixtureRoutes(calls),
        Layer.succeed(RateLimits.PublicRelayRateLimits, {
          admit: () => {
            calls.limiter++;
            return Effect.void;
          },
        }),
      ).pipe(Effect.provide(HttpServer.layerServices));
      const endpoint = withCloudflarePublicRelayIdentity(bounded);
      const ingress = new Request("https://relay.test/v1/client/environment-links", {
        headers: {
          ...(ip === null ? {} : { "cf-connecting-ip": ip }),
          "x-forwarded-for": "192.0.2.1",
        },
      });
      const raw = rawRequest([encode("{}")]);
      expect(
        (yield* send(endpoint, raw.request).pipe(
          Effect.provideService(Cloudflare.Workers.Request, ingress),
        )).status,
      ).toBe(503);
      expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "isolates users, operation, issuer, stage and canonical IP class and fits20 clean startups",
    () =>
      Effect.gen(function* () {
        const limits = yield* RateLimits.PublicRelayRateLimits;
        const mix = [
          "registerManagedEndpointRecovery",
          "recoverManagedEndpoint",
          "createEnvironmentLinkChallenge",
          "exchangeDpopAccessToken",
          "connectEnvironment",
          "wakeHeldHooks",
          "updateLinkPreferences",
          "getEnvironmentStatus",
          "listEnvironments",
          "listDevicesV2",
        ] as const;
        for (let startup = 0; startup < 20; startup++)
          for (const operation of mix)
            yield* limits.admit(operation, { kind: "user", userId: "synthetic-user" });
        for (let extra = 0; extra < 10; extra++)
          yield* limits.admit("recoverManagedEndpoint", { kind: "user", userId: "synthetic-user" });
        expect(
          (yield* Effect.flip(
            limits.admit("recoverManagedEndpoint", { kind: "user", userId: "synthetic-user" }),
          ))._tag,
        ).toBe("PublicRelayRateLimited");
        yield* limits.admit("registerManagedEndpointRecovery", {
          kind: "user",
          userId: "synthetic-user",
        });
        yield* limits.admit("recoverManagedEndpoint", {
          kind: "user",
          userId: "synthetic-other-user",
        });
        const user = { kind: "user", userId: "synthetic-user" } as const;
        const key = RateLimits.publicRelayLimiterKey(
          { issuer: "https://relay.test", stage: "stage-a" },
          "recoverManagedEndpoint",
          user,
        );
        expect(key).not.toBe(
          RateLimits.publicRelayLimiterKey(
            { issuer: "https://relay.test", stage: "stage-b" },
            "recoverManagedEndpoint",
            user,
          ),
        );
        expect(key).not.toBe(
          RateLimits.publicRelayLimiterKey(
            { issuer: "https://other.test", stage: "stage-a" },
            "recoverManagedEndpoint",
            user,
          ),
        );
        expect(canonicalEdgeIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
          canonicalEdgeIp("2001:db8::1"),
        );
        const edge = { kind: "edge", ip: "192.0.2.1" } as const;
        expect(
          RateLimits.publicRelayLimiterKey(
            { issuer: "i", stage: "s" },
            "recoverManagedEndpoint",
            edge,
          ),
        ).toBe(
          RateLimits.publicRelayLimiterKey({ issuer: "i", stage: "s" }, "linkEnvironment", edge),
        );
        expect(publicRelayBuckets.provision.period).toBe(60);
      }).pipe(
        Effect.provide(
          RateLimits.layerCloudflare(
            { issuer: "https://relay.test", stage: "stage-a" },
            {
              30: {
                limit: ({ key }) =>
                  Effect.sync(() => {
                    const count = (fleetCounters.get(key) ?? 0) + 1;
                    fleetCounters.set(key, count);
                    return { success: count <= 30 };
                  }),
              },
              120: { limit: () => Effect.succeed({ success: true }) },
              240: { limit: () => Effect.succeed({ success: true }) },
              60: { limit: () => Effect.succeed({ success: true }) },
            },
          ),
        ),
      ),
  );

  it.effect.each(["deny", "failure", "defect", "missing", "interrupt"] as const)(
    "adapter %s preserves typed failclosed/interruption",
    (kind) =>
      Effect.gen(function* () {
        const limiter = yield* RateLimits.PublicRelayRateLimits;
        const exit = yield* limiter
          .admit("linkEnvironment", { kind: "user", userId: "synthetic-user" })
          .pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure" && kind !== "interrupt") {
          const error = yield* limiter
            .admit("linkEnvironment", { kind: "user", userId: "synthetic-user" })
            .pipe(Effect.flip);
          expect(error._tag).toBe(
            kind === "deny" ? "PublicRelayRateLimited" : "PublicRelayLimiterUnavailable",
          );
        }
      }).pipe(
        Effect.provide(
          RateLimits.layerCloudflare(
            { issuer: "i", stage: "s" },
            kind === "missing"
              ? {}
              : {
                  30: {
                    limit: () =>
                      kind === "deny"
                        ? Effect.succeed({ success: false })
                        : kind === "failure"
                          ? Effect.fail({ _tag: "BindingFailed" })
                          : kind === "interrupt"
                            ? Effect.interrupt
                            : Effect.die("binding defect"),
                  },
                },
          ),
        ),
      ),
  );
});
const fleetCounters = new Map<string, number>();

it.effect.each([
  { name: "rejecting reader cancel", size: 65537, rejectCancel: true, form: false },
  { name: "very large single chunk", size: 4 * 1024 * 1024, rejectCancel: false, form: false },
  { name: "65537 form overflow", size: 65537, rejectCancel: false, form: true },
])(
  "real boundary rejects $name with reader cleanup and zero downstream work",
  ({ size, rejectCancel, form }) =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const formPrefix = "subject_token=fixture";
      const chunk = form
        ? encode(formPrefix + "&".repeat(size - formPrefix.length))
        : new Uint8Array(size);
      const raw = rawRequest([chunk, encode("unread")], {
        rejectCancel,
        ...(form
          ? {
              url: "https://relay.test/v1/client/dpop-token",
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }
          : {}),
      });
      const response = yield* send(endpoint, raw.request);
      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "RelayRequestTooLargeError",
        code: "relay_request_too_large",
      });
      expect(raw.read()).toBe(1);
      expect(raw.cancelled()).toBe(1);
      expect(raw.request.body?.locked).toBe(false);
      expect(calls).toEqual({ auth: 0, business: 0, limiter: 1 });
    }).pipe(Effect.scoped),
);
it.effect(
  "production composition provides the configured limiter to construction and outer request admission without capturing identity",
  () =>
    Effect.gen(function* () {
      const calls = counts();
      let constructionLimiter: RateLimits.PublicRelayRateLimits["Service"] | undefined;
      let bindingCalls = 0;
      const limits = RateLimits.layerCloudflare(
        { issuer: "https://relay.test", stage: "offline" },
        {
          edge: {
            limit: () =>
              Effect.sync(() => {
                bindingCalls++;
                return { success: true };
              }),
          },
        },
      );
      const endpoint = yield* assemblePublicRelayHttp(
        fixtureRoutes(calls, false, (limiter, identity) => {
          constructionLimiter = Option.getOrUndefined(limiter);
          expect(Option.isNone(identity)).toBe(true);
        }),
        limits,
      ).pipe(Effect.provide(HttpServer.layerServices));
      expect(constructionLimiter).toBeDefined();
      yield* constructionLimiter!.admit("health", { kind: "edge", ip: "192.0.2.2" });
      const response = yield* send(
        withCloudflarePublicRelayIdentity(endpoint).pipe(
          Effect.provideService(
            Cloudflare.Workers.Request,
            new Request("https://relay.test/health", {
              headers: { "cf-connecting-ip": "192.0.2.1" },
            }),
          ),
        ),
        new Request("https://relay.test/health"),
      );
      expect(response.status).toBe(200);
      expect(bindingCalls).toBe(2);
      expect(calls.business).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "local JWT crit precheck enforces item type and 256 boundary while tolerating bounded unknown extensions",
  () =>
    Effect.sync(() => {
      const token = (crit: unknown) =>
        `${Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", crit, harmless: { enabled: true } })).toString("base64url")}.e30.c2ln`;
      expect(isBoundedJwt(token(["x".repeat(256)]), 16384)).toBe(true);
      expect(isBoundedJwt(token(["x".repeat(257)]), 16384)).toBe(false);
      expect(isBoundedJwt(token([123]), 16384)).toBe(false);
      expect(isBoundedJwt(token(Array.from({ length: 8 }, () => "extension")), 16384)).toBe(true);
      expect(isBoundedJwt(token(Array.from({ length: 9 }, () => "extension")), 16384)).toBe(false);
    }),
);

it.effect.each([
  { label: "name-heavy", name: "x".repeat(8191), value: "v" },
  { label: "split name/value", name: "x".repeat(4096), value: "v".repeat(4096) },
  { label: "encoded value bytes", name: "x".repeat(4096), value: "é".repeat(2048) },
])(
  "generic individual $label header accepts8192 and rejects8193 before admission/capture",
  ({ name, value }) =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      expect(encode(name).byteLength + encode(value).byteLength).toBe(8192);
      const admitted = rawRequest([encode("{}")], { headers: { [name]: value } });
      expect(
        (yield* send(endpoint, admitted.request).pipe(
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
        )).status,
      ).toBe(200);
      yield* Effect.yieldNow;
      expect(spans.at(-1)?.attributes.get(`http.request.header.${name}`)).toBe(value);
      expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
      const rejected = rawRequest([encode("{}")], {
        headers: { [name]: value + "x" },
        neverCancel: true,
      });
      const response = yield* send(endpoint, rejected.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      expect(response.status).toBe(431);
      const body = yield* decodeHeadersTooLarge(yield* Effect.promise(() => response.json()));
      expect(body).toMatchObject({
        _tag: "RelayRequestHeadersTooLargeError",
        code: "relay_request_headers_too_large",
        traceId: expect.any(String),
      });
      expect(response.headers.get("traceparent")).toContain(body.traceId);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(rejected.read()).toBe(0);
      expect(rejected.cancelled()).toBe(1);
      expect(rejected.request.body?.locked).toBe(false);
      expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
      yield* Effect.yieldNow;
      expect(spans.at(-1)?.attributes.get(`http.request.header.${name}`)).toBeUndefined();
      expect(spans.at(-1)?.attributes.get("url.path")).toBe("/__relay_rejected_request__");
    }).pipe(Effect.scoped),
);
it.effect("generic name8193 itself is rejected before trace capture or downstream work", () =>
  Effect.gen(function* () {
    const calls = counts();
    const endpoint = yield* withBoundary(calls);
    const name = "x".repeat(8193);
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const raw = rawRequest([encode("{}")], { headers: { [name]: "v" }, rejectCancel: true });
    expect(
      (yield* send(endpoint, raw.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      )).status,
    ).toBe(431);
    expect(raw.read()).toBe(0);
    expect(raw.cancelled()).toBe(1);
    expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
    yield* Effect.yieldNow;
    expect(spans.at(-1)?.attributes.get(`http.request.header.${name}`)).toBeUndefined();
    expect(spans.at(-1)?.attributes.get("url.path")).toBe("/__relay_rejected_request__");
  }).pipe(Effect.scoped),
);
it.effect.each([
  { name: "authorization", value: "x".repeat(16384) },
  { name: "dpop", value: "x".repeat(8192) },
  {
    name: "content-type",
    value: "application/json;" + "x".repeat(256 - "application/json;".length),
  },
  { name: "content-length", value: "0".repeat(128) },
  { name: "traceparent", value: "x".repeat(128) },
])("special $name ceiling excludes the name and retains its declared units", ({ name, value }) =>
  Effect.gen(function* () {
    const calls = counts();
    const endpoint = yield* withBoundary(calls);
    expect(
      (yield* send(endpoint, rawRequest([encode("{}")], { headers: { [name]: value } }).request))
        .status,
    ).toBe(200);
    const raw = rawRequest([encode("{}")], {
      headers: { [name]: value + (name === "content-length" ? "0" : "x") },
    });
    expect((yield* send(endpoint, raw.request)).status).toBe(431);
    expect(raw.read()).toBe(0);
    expect(raw.cancelled()).toBe(1);
    expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
  }).pipe(Effect.scoped),
);
it.effect(
  "aggregate32768 still counts names and values independently of the generic individual limit",
  () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const headers = Object.fromEntries(
        [0, 1, 2].map((index) => {
          const name = `x-aggregate-${index}`;
          return [name, "x".repeat(8192 - encode(name).byteLength)];
        }),
      );
      const admitted = rawRequest([encode("{}")], {
        headers: { ...headers, "x-aggregate-final": "" },
      });
      const total = [...admitted.request.headers].reduce(
        (sum, [name, value]) => sum + encode(name).byteLength + encode(value).byteLength,
        0,
      );
      admitted.request.headers.set("x-aggregate-final", "x".repeat(32768 - total));
      expect((yield* send(endpoint, admitted.request)).status).toBe(200);
      const rejected = rawRequest([encode("{}")], {
        headers: Object.fromEntries(admitted.request.headers),
      });
      rejected.request.headers.set(
        "x-aggregate-final",
        rejected.request.headers.get("x-aggregate-final") + "x",
      );
      expect((yield* send(endpoint, rejected.request)).status).toBe(431);
      expect(rejected.read()).toBe(0);
      expect(rejected.cancelled()).toBe(1);
      expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
    }).pipe(Effect.scoped),
);

it.effect(
  "Content-Type admits250/reproduction251/256 non-ASCII characters and rejects257 before admission with safe tracing",
  () =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const contentType = (characters: number) => {
        const prefix = 'application/json;description="';
        return prefix + "é".repeat(characters - prefix.length - 1) + '"';
      };
      for (const characters of [250, 251, 256]) {
        const value = contentType(characters);
        expect(value.length).toBe(characters);
        expect(encode(value).byteLength).toBeGreaterThan(256);
        if (characters === 251)
          expect(value).toBe('application/json;description="' + "é".repeat(220) + '"');
        const raw = rawRequest([encode('{"valid":true}')], { headers: { "content-type": value } });
        const response = yield* send(endpoint, raw.request).pipe(
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          text: '{"valid":true}',
          method: "POST",
        });
        yield* Effect.yieldNow;
        expect(spans.at(-1)?.attributes.get("http.request.header.content-type")).toBe(value);
        expect(spans.at(-1)?.attributes.get("url.path")).toBe("/v1/client/environment-links");
        expect(routeViews.at(-1)?.headers["content-type"]).toBe(value);
      }
      expect(calls).toEqual({ auth: 3, business: 3, limiter: 3 });
      const value = contentType(257);
      expect(value.length).toBe(257);
      const raw = rawRequest([encode('{"valid":true}')], {
        headers: { "content-type": value },
        neverCancel: true,
      });
      const response = yield* send(endpoint, raw.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      expect(response.status).toBe(431);
      const error = yield* decodeHeadersTooLarge(yield* Effect.promise(() => response.json()));
      expect(error.code).toBe("relay_request_headers_too_large");
      expect(response.headers.get("traceparent")).toContain(error.traceId);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toContain("retry-after");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
      expect(raw.request.body?.locked).toBe(false);
      expect(calls).toEqual({ auth: 3, business: 3, limiter: 3 });
      yield* Effect.yieldNow;
      expect(spans.at(-1)?.attributes.get("http.request.header.content-type")).toBeUndefined();
      expect(spans.at(-1)?.attributes.get("url.path")).toBe("/__relay_rejected_request__");
    }).pipe(Effect.scoped),
);
it.effect.each([
  { name: "authorization", bytes: 16384 },
  { name: "dpop", bytes: 8192 },
])("$name remains a byte ceiling for non-ASCII values", ({ name, bytes }) =>
  Effect.gen(function* () {
    const calls = counts();
    const endpoint = yield* withBoundary(calls);
    const value = "é".repeat(bytes / 2);
    expect(encode(value).byteLength).toBe(bytes);
    expect(
      (yield* send(endpoint, rawRequest([encode("{}")], { headers: { [name]: value } }).request))
        .status,
    ).toBe(200);
    const raw = rawRequest([encode("{}")], { headers: { [name]: value + "x" } });
    expect((yield* send(endpoint, raw.request)).status).toBe(431);
    expect(raw.read()).toBe(0);
    expect(raw.cancelled()).toBe(1);
    expect(calls).toEqual({ auth: 1, business: 1, limiter: 1 });
  }).pipe(Effect.scoped),
);

it.effect.each(
  (
    [
      ["POST", "/v1/hooks/not-a-route"],
      ["POST", "/V1/HOOKS/not-a-route"],
      ["POST", "/%76%31/hooks/not-a-route"],
      ["DELETE", "/v1/hooks/endpoint/hook/private-token"],
      ["DELETE", "/V1/HOOKS/endpoint/hook/private-token"],
      ["DELETE", "/%76%31/hooks/endpoint/hook/private-token"],
      ["POST", "/v1/hooks/endpoint/hook/" + "t".repeat(513)],
      ["POST", "/v1/hooks/endpoint/hook/private-token/extra"],
    ] as const
  ).map(([method, path]) => ({ method, path })),
)("cancels unknown hook route $method $path without reads or downstream work", ({ method, path }) =>
  Effect.gen(function* () {
    const calls = counts();
    const endpoint = yield* withBoundary(calls);
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const raw = rawRequest([encode("raw-body")], {
      method,
      url: "https://relay.test" + path + "?sender-secret=private-query",
      neverCancel: true,
    });
    const response = yield* send(endpoint, raw.request).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
    );
    expect(response.status).toBe(404);
    expect(raw.read()).toBe(0);
    expect(raw.cancelled()).toBe(1);
    expect(raw.request.body?.locked).toBe(false);
    expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
    const attributes = JSON.stringify(spans.map((span) => Array.from(span.attributes)));
    expect(attributes).not.toContain("private-token");
    expect(attributes).not.toContain("private-query");
  }).pipe(Effect.scoped),
);

it.effect.each(["/v1/hooks/", "/V1/HOOKS/", "/%76%31/hooks/"])(
  "redacts malformed hook alias%s without changing actual routing or cancellation",
  (prefix) =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const raw = rawRequest([encode("raw-body")], {
        url:
          "https://relay.test" +
          prefix +
          "endpoint/hook/private-token/%ZZ?sender-secret=private-query",
        neverCancel: true,
      });
      const response = yield* send(endpoint, raw.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      expect(response.status).toBe(404);
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
      expect(raw.request.body?.locked).toBe(false);
      expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
      expect(spans).toHaveLength(1);
      const attributes = JSON.stringify(Array.from(spans[0]!.attributes));
      expect(attributes).not.toContain("private-token");
      expect(attributes).not.toContain("private-query");
      expect(spans[0]!.attributes.get("url.query")).toBeUndefined();
      expect(raw.request.url).toContain("private-token/%ZZ?sender-secret=private-query");
      if (prefix === "/v1/hooks/")
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }).pipe(Effect.scoped),
);

it.effect.each(["/v1/hooks/", "/V1/HOOKS/", "/%76%31/hooks/"])(
  "redacts CUSTOM hook alias%s without granting method admission",
  (prefix) =>
    Effect.gen(function* () {
      const calls = counts();
      const endpoint = yield* withBoundary(calls);
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const raw = rawRequest([encode("raw-body")], {
        method: "CUSTOM",
        url:
          "https://relay.test" + prefix + "endpoint/hook/private-token?sender-secret=private-query",
        neverCancel: true,
      });
      const response = yield* send(endpoint, raw.request).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpMiddleware.TracerHeaderFilter, () => true),
      );
      expect(response.status).toBe(404);
      expect(raw.read()).toBe(0);
      expect(raw.cancelled()).toBe(1);
      expect(raw.request.body?.locked).toBe(false);
      expect(calls).toEqual({ auth: 0, business: 0, limiter: 0 });
      expect(spans).toHaveLength(1);
      const attributes = JSON.stringify(Array.from(spans[0]!.attributes));
      expect(attributes).not.toContain("private-token");
      expect(attributes).not.toContain("private-query");
      expect(spans[0]!.attributes.get("url.query")).toBeUndefined();
      expect(raw.request.method).toBe("CUSTOM");
      expect(raw.request.url).toContain("private-token?sender-secret=private-query");
      if (prefix === "/v1/hooks/")
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }).pipe(Effect.scoped),
);
