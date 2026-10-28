import * as FindMyWay from "effect/http/FindMyWay";

/** Public HTTP admission policy. Hook namespaces 1001/1002 are independent. */
export const publicRelayBuckets = {
  provision: { namespaceId: 1101, limit: 30, period: 60 },
  challenge: { namespaceId: 1102, limit: 120, period: 60 },
  connect: { namespaceId: 1102, limit: 120, period: 60 },
  status: { namespaceId: 1103, limit: 240, period: 60 },
  registration: { namespaceId: 1104, limit: 60, period: 60 },
  "push-test": { namespaceId: 1105, limit: 10, period: 60 },
  activity: { namespaceId: 1103, limit: 240, period: 60 },
  "anonymous-registration": { namespaceId: 1104, limit: 60, period: 60 },
  // The edge-only config route has this proposed ceiling, but its mandatory ingress gate is120/IP+class.
  "anonymous-config": { namespaceId: 1103, limit: 240, period: 60 },
  health: { namespaceId: 1106, limit: 120, period: 60 },
} as const;

export type PublicRelayClass = keyof typeof publicRelayBuckets;
export const publicRelayOperations = {
  linkEnvironment: ["POST", "/v1/client/environment-links", "provision"],
  recoverManagedEndpoint: ["POST", "/v1/environments/:environmentId/tunnel", "provision"],
  registerManagedEndpointRecovery: [
    "POST",
    "/v1/environments/:environmentId/tunnel/recovery",
    "provision",
  ],
  unlinkEnvironment: ["DELETE", "/v1/client/environment-links/:environmentId", "provision"],
  releaseEnvironmentTunnel: [
    "DELETE",
    "/v1/client/environment-links/:environmentId/tunnel",
    "provision",
  ],
  createEnvironmentLinkChallenge: ["POST", "/v1/client/environment-link-challenges", "challenge"],
  exchangeDpopAccessToken: ["POST", "/v1/client/dpop-token", "challenge"],
  connectEnvironment: ["POST", "/v1/environments/:environmentId/connect", "connect"],
  getEnvironmentStatus: ["POST", "/v1/environments/:environmentId/status", "status"],
  listEnvironments: ["GET", "/v1/environments", "status"],
  listDevices: ["GET", "/v1/client/devices", "status"],
  listDevicesV2: ["GET", "/v2/client/devices", "status"],
  getT3ChatLink: ["GET", "/v1/client/t3chat-link", "status"],
  createT3ChatLinkRequest: ["POST", "/v1/client/t3chat-link-requests", "challenge"],
  unlinkT3Chat: ["DELETE", "/v1/client/t3chat-link", "registration"],
  getAgentActivitySnapshot: ["GET", "/v1/mobile/agent-activity", "status"],
  getWebPushConfig: ["GET", "/v1/client/web-push/config", "status"],
  registerDevice: ["POST", "/v1/mobile/devices", "registration"],
  registerLiveActivity: ["POST", "/v1/mobile/live-activities", "registration"],
  unregisterDevice: ["DELETE", "/v1/mobile/devices/:deviceId", "registration"],
  registerWebPushSubscription: ["PUT", "/v1/client/web-push/subscriptions", "registration"],
  unregisterWebPushSubscription: [
    "DELETE",
    "/v1/client/web-push/subscriptions/:subscriptionId",
    "registration",
  ],
  updateLinkPreferences: [
    "POST",
    "/v1/environments/:environmentId/link-preferences",
    "registration",
  ],
  wakeHeldHooks: ["POST", "/v1/environments/:environmentId/hooks/wake", "registration"],
  testWebPushSubscription: [
    "POST",
    "/v1/client/web-push/subscriptions/:subscriptionId/test",
    "push-test",
  ],
  testPwaWebPushSubscription: [
    "POST",
    "/v1/pwa/web-push/subscriptions/:subscriptionId/test",
    "push-test",
  ],
  publishAgentActivity: [
    "POST",
    "/v1/environments/:environmentId/threads/:threadId/agent-activity",
    "activity",
  ],
  publishPwaAgentActivity: [
    "POST",
    "/v1/pwa/environments/:environmentId/threads/:threadId/agent-activity",
    "activity",
  ],
  registerPwaWebPushSubscription: [
    "PUT",
    "/v1/pwa/web-push/subscriptions",
    "anonymous-registration",
  ],
  removePwaWebPushSubscription: [
    "POST",
    "/v1/pwa/web-push/subscriptions/:subscriptionId/remove",
    "anonymous-registration",
  ],
  getPwaWebPushConfig: ["GET", "/v1/pwa/web-push/config", "anonymous-config"],
  health: ["GET", "/health", "health"],
} as const satisfies Record<string, readonly [string, string, PublicRelayClass]>;
export type PublicRelayOperation = keyof typeof publicRelayOperations;

export const publicRelayBounds = {
  bodyBytes: 65_536,
  urlCharacters: 8_192,
  headersBytes: 32_768,
  authorizationBytes: 16_384,
  dpopBytes: 8_192,
  headerBytes: 8_192,
  contentTypeCharacters: 256,
  contentLengthCharacters: 128,
  traceparentCharacters: 128,
} as const;

const headerEncoder = new TextEncoder();
export function publicRelayHeaderFailure(headers: Readonly<Record<string, string>>): boolean {
  let total = 0;
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = headerEncoder.encode(name).byteLength;
    const bytes = headerEncoder.encode(value).byteLength;
    const max =
      name === "authorization"
        ? publicRelayBounds.authorizationBytes
        : name === "dpop"
          ? publicRelayBounds.dpopBytes
          : name === "content-type"
            ? publicRelayBounds.contentTypeCharacters
            : name === "content-length"
              ? publicRelayBounds.contentLengthCharacters
              : name === "traceparent"
                ? publicRelayBounds.traceparentCharacters
                : publicRelayBounds.headerBytes - nameBytes;
    const individualSize =
      name === "content-type" || name === "content-length" || name === "traceparent"
        ? value.length
        : bytes;
    // Three named values use characters; auth/DPoP use bytes. Generic/aggregate include encoded names.
    total += nameBytes + bytes;
    if (individualSize > max || total > publicRelayBounds.headersBytes) return true;
  }
  return false;
}

type PolicyRoute =
  | { readonly operation: PublicRelayOperation; readonly kind: PublicRelayClass }
  | { readonly kind: "hook" }
  | { readonly kind: "mobile-telemetry" }
  | { readonly kind: "hook-trace" };
const routeClassifier = FindMyWay.make<PolicyRoute | undefined>({ maxParamLength: 512 });
for (const [operation, [method, template, kind]] of Object.entries(publicRelayOperations))
  routeClassifier.on(method, template, { operation: operation as PublicRelayOperation, kind });
for (const method of ["POST", "PUT", "PATCH", "GET"])
  routeClassifier.on(method, "/v1/hooks/:endpointKey/:hookId/:token", { kind: "hook" });
// Privacy marker only: malformed/unsupported hook paths cannot confer raw forwarding.
routeClassifier.all("/v1/hooks/*", { kind: "hook-trace" });
// Telemetry has an independent 2 MiB streaming cap and per-IP limiter.
routeClassifier.on("POST", "/v1/mobile/observe/:projectId/v1/:signal", {
  kind: "mobile-telemetry",
});
// Match the production catch-all, including its effect on HEAD -> GET fallback.
routeClassifier.all("/*", undefined);
export function classifyPublicRelayRoute(
  method: string,
  url: string,
): Extract<PolicyRoute, { readonly operation: PublicRelayOperation }> | undefined {
  const result =
    routeClassifier.find(method, url) ??
    (method === "HEAD" ? routeClassifier.find("GET", url) : undefined);
  return result?.handler && "operation" in result.handler ? result.handler : undefined;
}

// The installed matcher splits query/fragment/semicolon suffixes. Bound only the path
// before giving it to that matcher, preserving previously exempt genuine long queries.
function boundedRelayPath(url: string): string | undefined {
  for (let index = 0; index <= publicRelayBounds.urlCharacters; index++) {
    const char = url[index];
    if (char === undefined || char === "?" || char === "#" || char === ";")
      return url.slice(0, index);
  }
  return undefined;
}
function hookRoute(method: string, url: string) {
  const path = boundedRelayPath(url);
  return path === undefined ? undefined : routeClassifier.find(method, path);
}

/** Failed URI decoding selects a safe trace view, never route admission. */
export function relayTracePathDecodeFails(url: string): boolean {
  const path = boundedRelayPath(url);
  if (path === undefined) return true;
  try {
    decodeURI(path);
    return false;
  } catch {
    return true;
  }
}

export function isRelayHookRequest(method: string, url: string): boolean {
  return hookRoute(method, url)?.handler?.kind === "hook";
}
export function isRelayMobileTelemetryRequest(method: string, url: string): boolean {
  return hookRoute(method, url)?.handler?.kind === "mobile-telemetry";
}
export function isRelayHookTraceRequest(url: string): boolean {
  // Privacy uses the existing GET table even when an extension method has no table.
  // This lookup never grants the incoming request raw forwarding or public admission.
  const kind = hookRoute("GET", url)?.handler?.kind;
  return kind === "hook" || kind === "hook-trace";
}
export function relayHookTraceUrl(method: string, url: string): string {
  const hook = hookRoute(method, url);
  if (hook?.handler?.kind !== "hook") return "/v1/hooks/redacted";
  return `/v1/hooks/${encodeURIComponent(hook.params.endpointKey ?? "redacted")}/${encodeURIComponent(hook.params.hookId ?? "redacted")}/redacted`;
}

/** Only a single canonical address supplied by the fetch adapter is trusted. */
export function canonicalEdgeIp(value: string | null): string | undefined {
  if (!value || value.length > 64 || /[\s,%[\]]/.test(value)) return undefined;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    const octets = value.split(".");
    if (octets.some((part) => part.length > 3 || Number(part) > 255)) return undefined;
    return octets.map(Number).join(".");
  }
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return undefined;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : undefined;
  } catch {
    return undefined;
  }
}
