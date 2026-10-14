import * as Cloudflare from "alchemy/Cloudflare";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  RelayServiceUnavailableError,
  RelayRequestTooLargeError,
  RelayRequestInvalidError,
  RelayRequestHeadersTooLargeError,
  CommonRelayPublicBoundaryErrors,
} from "@t3tools/contracts/relay";
import {
  relayCors,
  traceRelayHttpRequestWith,
  relayPublicLimitError,
  assembleRelayHttpRoutes,
} from "./Api.ts";
import { isRelayHookPath } from "../hooks/HookForwarder.ts";
import * as Layer from "effect/Layer";
import * as PublicRelayRateLimits from "./PublicRelayRateLimits.ts";
import {
  classifyPublicRelayRoute,
  publicRelayBounds,
  publicRelayHeaderFailure,
  canonicalEdgeIp,
  isRelayHookRequest,
} from "./publicRelayPolicy.ts";
import { assertRelayForm, parseBoundedJson } from "./publicRelayInputBounds.ts";

const encodeError = Schema.encodeSync(Schema.Union(CommonRelayPublicBoundaryErrors));
const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unknown"),
);
type BoundaryStatus = 400 | 413 | 431;
class BodyRejected extends Error {
  readonly status: BoundaryStatus;
  constructor(status: BoundaryStatus) {
    super("Relay body rejected");
    this.status = status;
  }
}
function cancelBody(request: Request): void {
  try {
    void request.body?.cancel().catch(() => {});
  } catch {
    /* Reply must survive cancellation failure. */
  }
}
function contentLengthFailure(value: string | undefined): BoundaryStatus | undefined {
  if (value === undefined) return undefined;
  const decimal = value.trim();
  if (!/^\d+$/.test(decimal)) return 400;
  const normalized = decimal.replace(/^0+/, "") || "0";
  if (normalized.length > 5 || (normalized.length === 5 && normalized > "65536")) return 413;
  return value.length > publicRelayBounds.contentLengthCharacters ? 431 : undefined;
}

/** Consume only the ingress stream; never clone/tee or retain a would-overflow chunk. */
const readBody = (request: Request) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!request.body) return new Uint8Array(0);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let ended = false;
      let rejectAbort: (() => void) | undefined;
      const cancel = () => {
        try {
          void reader.cancel().catch(() => {});
        } catch {}
      };
      const abort = () => {
        rejectAbort?.();
        cancel();
      };
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new BodyRejected(400));
      });
      signal.addEventListener("abort", abort, { once: true });
      request.signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted || request.signal.aborted) throw new BodyRejected(400);
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (signal.aborted || request.signal.aborted) throw new BodyRejected(400);
          if (chunk.done) {
            ended = true;
            break;
          }
          if (chunk.value.byteLength > publicRelayBounds.bodyBytes - bytes)
            throw new BodyRejected(413);
          bytes += chunk.value.byteLength;
          chunks.push(chunk.value);
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body;
      } finally {
        signal.removeEventListener("abort", abort);
        request.signal.removeEventListener("abort", abort);
        if (!ended) cancel();
        try {
          reader.releaseLock();
        } catch {}
      }
    },
    catch: (error) => (error instanceof BodyRejected ? error : new BodyRejected(400)),
  });

function responseFor(error: (typeof CommonRelayPublicBoundaryErrors)[number]["Type"]) {
  const status =
    error._tag === "RelayRateLimitExceededError"
      ? 429
      : error._tag === "RelayServiceUnavailableError"
        ? 503
        : error._tag === "RelayRequestTooLargeError"
          ? 413
          : error._tag === "RelayRequestHeadersTooLargeError"
            ? 431
            : 400;
  return HttpServerResponse.jsonUnsafe(encodeError(error), {
    status,
    headers: status === 429 ? { "retry-after": "60" } : {},
  });
}
function rejected(status: BoundaryStatus, traceId: string) {
  return responseFor(
    status === 413
      ? new RelayRequestTooLargeError({ code: "relay_request_too_large", traceId })
      : status === 431
        ? new RelayRequestHeadersTooLargeError({ code: "relay_request_headers_too_large", traceId })
        : new RelayRequestInvalidError({ code: "relay_request_invalid", traceId }),
  );
}

function validBodyInput(bytes: Uint8Array, contentTypeHeader: string | undefined): boolean {
  try {
    const contentType = (contentTypeHeader ?? "application/json")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType === "application/json" && bytes.byteLength > 0)
      parseBoundedJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        publicRelayBounds.bodyBytes,
      );
    else if (contentType === "application/x-www-form-urlencoded")
      assertRelayForm(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return true;
  } catch {
    return false;
  }
}

const boundedBoundary = <E, R>(
  router: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  original: Request | undefined,
  aborted: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const traceId = yield* currentTraceId;
    const early = (status: BoundaryStatus) => {
      if (original) cancelBody(original);
      return rejected(status, traceId);
    };
    if (
      request.url.length > publicRelayBounds.urlCharacters ||
      request.originalUrl.length > publicRelayBounds.urlCharacters
    )
      return early(413);
    // Oversized all-decimal CL must be 413 even when it exceeds the header cap.
    const lengthFailure = contentLengthFailure(request.headers["content-length"]);
    if (lengthFailure) return early(lengthFailure);
    if (publicRelayHeaderFailure(request.headers)) return early(431);
    if (request.method === "OPTIONS") {
      if (original) cancelBody(original);
      return isRelayHookPath(request.url)
        ? yield* router
        : HttpServerResponse.empty({ status: 204 });
    }
    const route = classifyPublicRelayRoute(request.method, request.url);
    if (!route) {
      // Static metadata is bounded but does not drain a body or authenticate; unknowns retain router status.
      if (original) cancelBody(original);
      return yield* router;
    }
    if (original?.signal.aborted) return early(400);
    const identity = yield* PublicRelayRateLimits.TrustedEdgeIdentity;
    const canonicalIp = identity.status === "available" ? canonicalEdgeIp(identity.ip) : undefined;
    if (canonicalIp === undefined || !original) {
      if (original) cancelBody(original);
      return responseFor(
        new RelayServiceUnavailableError({
          code: "relay_unavailable",
          reason: "internal",
          traceId,
        }),
      );
    }
    const limiter = yield* PublicRelayRateLimits.PublicRelayRateLimits;
    const limited = yield* limiter.admit(route.operation, { kind: "edge", ip: canonicalIp }).pipe(
      Effect.map(() => Option.none<HttpServerResponse.HttpServerResponse>()),
      Effect.catch((error) =>
        Effect.succeedSome(responseFor(relayPublicLimitError(error, traceId))),
      ),
      Effect.raceFirst(
        Deferred.await(aborted).pipe(Effect.as(Option.some(rejected(400, traceId)))),
      ),
    );
    if (Option.isSome(limited)) {
      cancelBody(original);
      return limited.value;
    }
    const body = yield* readBody(original).pipe(
      Effect.map((bytes) => ({ _tag: "Body" as const, bytes })),
      Effect.catch((error) => Effect.succeed({ _tag: "Rejected" as const, status: error.status })),
    );
    if (body._tag === "Rejected") return early(body.status);
    if (!validBodyInput(body.bytes, request.headers["content-type"])) return early(400);
    const bounded = new Request(original.url, {
      method: original.method,
      headers: original.headers,
      signal: original.signal,
      ...(original.method === "GET" || original.method === "HEAD" ? {} : { body: body.bytes }),
    });
    // Web Request construction follows the signal; retain the ingress signal identity for route consumers too.
    Object.defineProperty(bounded, "signal", { value: original.signal });
    const boundedEffect = HttpServerRequest.fromWeb(bounded).modify({
      url: request.url,
      headers: request.headers,
      remoteAddress: request.remoteAddress,
    });
    return yield* router.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, boundedEffect),
    );
  });

const boundary = <E, R>(router: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Hook byte limits and raw forwarding belong to HookForwarder, without reconstruction.
    if (isRelayHookRequest(request.method, request.url)) return yield* router;
    const original = request.source instanceof Request ? request.source : undefined;
    const aborted = Deferred.makeUnsafe<void>();
    // An active reader owns its cancellation/release; this bracket owns unread ingress.
    const cancelUnread = () => {
      if (original && !original.bodyUsed && !original.body?.locked) cancelBody(original);
    };
    const abort = () => {
      cancelUnread();
      Deferred.doneUnsafe(aborted, Effect.void);
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        original?.signal.addEventListener("abort", abort, { once: true });
        if (original?.signal.aborted) abort();
      }),
      () => boundedBoundary(router, request, original, aborted),
      () =>
        Effect.sync(() => {
          original?.signal.removeEventListener("abort", abort);
          cancelUnread();
        }),
    );
  });

/** The real outer production boundary, also used by offline request fixtures. */
export const wrapPublicRelayHttp = <E, R>(
  router: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => traceRelayHttpRequestWith(relayCors(boundary(router)), Layer.empty);

/** Reuse the configured limiter for captured HTTP service construction and outer admission. */
export const assemblePublicRelayHttp = <A, E, R>(
  layerApp: Layer.Layer<A, E, R>,
  limiter: Layer.Layer<PublicRelayRateLimits.PublicRelayRateLimits>,
) =>
  assembleRelayHttpRoutes(layerApp.pipe(Layer.provideMerge(limiter))).pipe(
    Effect.map((router) => wrapPublicRelayHttp(router).pipe(Effect.provide(limiter))),
  );

/** Production fetch adapter: the Workers request is fetched per execution, never memoized. */
export const withCloudflarePublicRelayIdentity = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ingress = yield* Cloudflare.Workers.Request;
    const ip = canonicalEdgeIp(ingress.headers.get("cf-connecting-ip"));
    return yield* effect.pipe(
      Effect.provideService(
        PublicRelayRateLimits.TrustedEdgeIdentity,
        ip === undefined ? { status: "unavailable" } : { status: "available", ip },
      ),
    );
  });
