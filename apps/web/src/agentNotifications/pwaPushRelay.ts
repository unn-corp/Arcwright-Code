import type { RelayWebPushPreferences } from "@t3tools/contracts/relay";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const INSTALLATION_ID_KEY = "t3code.pwaPushInstallationId";
const INSTALLATION_SECRET_KEY = "t3code.pwaPushInstallationSecret";
const LEGACY_SUBSCRIPTION_KEY = "t3code.webPushSubscriptionId";
const CLEANUP_PENDING_KEY = "t3code.pwaPushCleanupPending.v1";
const SCOPED_RECORD_PREFIX = "t3code.pwaPushAuthority.v1:";
const REMOVAL_MARKER_PREFIX = "t3code.pwaPushRemovalPending.v1:";
const REGISTRATION_MARKER_PREFIX = "t3code.pwaPushRegistrationPending.v1:";
type RemovalOperation = {
  state: "pending" | "uncertain";
  promise: Promise<void>;
  installation: Installation;
};
const pendingRemovals = new Map<string, RemovalOperation>();
const registrationGenerations = new Map<string, number>();
const pendingRegistrations = new Map<string, Set<Promise<string>>>();
const activeRegistrationMarkers = new Map<string, string>();

type Installation = {
  readonly installationId: string;
  readonly installationSecret: string;
};
type SubscriptionRecord = {
  readonly subscriptionId: string;
  readonly applicationServerKey: string;
  readonly endpoint: string;
};
type AuthorityRecord = {
  readonly version: 1;
  readonly relayOrigin: string;
  readonly installation: Installation;
  readonly subscription: SubscriptionRecord | null;
};
export type PwaPushRelayProfile =
  | { readonly type: "available"; readonly mode: "legacy" | "owned"; readonly relayOrigin: string }
  | { readonly type: "blocked"; readonly reason: "cloudless" | "profile" };

export class PwaPushUnavailableError extends Error {
  constructor() {
    super("Remote notifications are unavailable for this Connect profile.");
    this.name = "PwaPushUnavailableError";
  }
}
class PwaPushTemporaryError extends Error {
  readonly traceId: string;
  constructor(message: string, traceId: string) {
    super(message);
    this.traceId = traceId;
  }
}
class PwaPushRateLimitedError extends PwaPushTemporaryError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, traceId: string) {
    super(
      `The notification service is temporarily rate limited. Try again in ${retryAfterSeconds} seconds.`,
      traceId,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Only validated429 proves pre-mutation rejection. Temporary503 retains mutation uncertainty.
async function publicRelayRejection(
  response: Response,
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
): Promise<PwaPushTemporaryError | undefined> {
  const current = getPwaPushRelayProfile();
  if (
    current.type !== "available" ||
    current.mode !== profile.mode ||
    current.relayOrigin !== profile.relayOrigin
  )
    return;
  try {
    if (new URL(response.url).origin !== profile.relayOrigin || !response.body) return;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > 4096 - size) {
          void reader.cancel().catch(() => {});
          return;
        }
        size += chunk.value.byteLength;
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      !("traceId" in value) ||
      typeof value.traceId !== "string" ||
      value.traceId.length === 0 ||
      value.traceId.length > 128
    )
      return;
    if (
      response.status === 503 &&
      "_tag" in value &&
      value._tag === "RelayServiceUnavailableError" &&
      "code" in value &&
      value.code === "relay_unavailable" &&
      "reason" in value &&
      value.reason === "internal"
    )
      return new PwaPushTemporaryError(
        "The notification service is temporarily unavailable. Try again when connected.",
        value.traceId,
      );
    if (
      response.status !== 429 ||
      !("_tag" in value) ||
      value._tag !== "RelayRateLimitExceededError" ||
      !("code" in value) ||
      value.code !== "relay_rate_limited" ||
      !("retryAfterSeconds" in value) ||
      value.retryAfterSeconds !== 60
    )
      return;
    const header = response.headers.get("retry-after");
    const delay =
      header && /^\d{1,4}$/.test(header) && Number(header) <= 3600
        ? Math.max(60, Number(header))
        : 60;
    return new PwaPushRateLimitedError(delay, value.traceId);
  } catch {
    return;
  }
}

export class PwaPushRemovalPendingError extends Error {
  constructor(recoveryRequired = false) {
    super(
      recoveryRequired
        ? "Remote notification setup or cleanup has an uncertain outcome. In owned mode, use Reset browser push, then Enable to enroll a fresh installation. Legacy credentials are preserved and cannot be safely renewed until the old service setup and cleanup are confirmed."
        : "Remote notification setup or cleanup is still pending. Local Disable or Reset remains available. Enable notifications again after the remote request finishes.",
    );
    this.name = "PwaPushRemovalPendingError";
  }
}
class PwaPushBindingError extends Error {
  constructor() {
    super(
      "Reset this browser's push subscription, then explicitly enable notifications again. Previous service cleanup may still be pending.",
    );
    this.name = "PwaPushBindingError";
  }
}

/** Shared public-profile validation is authoritative; owned mode never falls back. */
export function getPwaPushRelayProfile(): PwaPushRelayProfile {
  try {
    const config = resolveCloudPublicConfig();
    if (config.connectMode === "cloudless") return { type: "blocked", reason: "cloudless" };
    if (config.connectMode === "owned" && !config.relayUrl)
      return { type: "blocked", reason: "profile" };
    return {
      type: "available",
      mode: config.connectMode,
      relayOrigin: config.relayUrl ?? "https://relay.t3.codes",
    };
  } catch {
    return { type: "blocked", reason: "profile" };
  }
}
function requireProfile() {
  const profile = getPwaPushRelayProfile();
  if (profile.type === "blocked") throw new PwaPushUnavailableError();
  return profile;
}
function recordKey(origin: string) {
  return `${SCOPED_RECORD_PREFIX}${encodeURIComponent(origin)}`;
}
function readRecord(origin: string): AuthorityRecord | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recordKey(origin)) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("relayOrigin" in value) ||
      value.relayOrigin !== origin ||
      !("installation" in value)
    )
      return null;
    const installation = value.installation;
    if (
      !installation ||
      typeof installation !== "object" ||
      !("installationId" in installation) ||
      typeof installation.installationId !== "string" ||
      !installation.installationId ||
      !("installationSecret" in installation) ||
      typeof installation.installationSecret !== "string" ||
      !installation.installationSecret
    )
      return null;
    if (!("subscription" in value)) return null;
    const subscription = value.subscription;
    if (
      subscription !== null &&
      (!subscription ||
        typeof subscription !== "object" ||
        !("subscriptionId" in subscription) ||
        typeof subscription.subscriptionId !== "string" ||
        !subscription.subscriptionId ||
        !("applicationServerKey" in subscription) ||
        typeof subscription.applicationServerKey !== "string" ||
        !("endpoint" in subscription) ||
        typeof subscription.endpoint !== "string")
    )
      return null;
    return value as AuthorityRecord;
  } catch {
    return null;
  }
}
function writeRecord(record: AuthorityRecord) {
  window.localStorage.setItem(recordKey(record.relayOrigin), JSON.stringify(record));
}
export function isPwaPushAuthorityResetRequired(): boolean {
  const profile = getPwaPushRelayProfile();
  if (profile.type === "blocked" || profile.mode !== "owned") return false;
  try {
    return (
      window.localStorage.getItem(recordKey(profile.relayOrigin)) !== null &&
      !readRecord(profile.relayOrigin)
    );
  } catch {
    return true;
  }
}

/** Explicit Reset only: preserve exact private bytes before freeing invalid or uncertain current authority. */
export function resetPwaPushAuthority(expectedProfile: PwaPushRelayProfile): void {
  if (expectedProfile.type === "blocked" || expectedProfile.mode !== "owned") return;
  const current = getPwaPushRelayProfile();
  if (
    current.type === "blocked" ||
    current.mode !== expectedProfile.mode ||
    current.relayOrigin !== expectedProfile.relayOrigin
  )
    throw new PwaPushBindingError();
  try {
    const key = recordKey(current.relayOrigin);
    const raw = window.localStorage.getItem(key);
    // A best-effort DELETE started by this Reset cannot resolve an earlier uncertain
    // PUT. Fresh credentials isolate both old requests after durable preservation.
    const recovering =
      getPwaPushRemovalState() === "uncertain" || registrationState(current) === "uncertain";
    const clearUncertainty = () => {
      for (const markerKey of [removalMarkerKey(current), registrationMarkerKey(current)]) {
        window.localStorage.removeItem(markerKey);
        if (window.localStorage.getItem(markerKey) !== null)
          throw new Error("uncertainty reset failed");
      }
      pendingRemovals.delete(authorityScope(current));
      activeRegistrationMarkers.delete(authorityScope(current));
    };
    if (raw === null) {
      if (recovering) clearUncertainty();
      return;
    }
    if (!recovering && readRecord(current.relayOrigin)) return;
    // Quarantine is credential-private local storage, never request authority. Bound the search
    // and refuse a full archive rather than overwriting any previous recovery record.
    const prefix = `${key}:quarantine:`;
    let preserved = false;
    for (let index = 0; index < 16; index += 1) {
      const archiveKey = `${prefix}${index}`;
      const archived = window.localStorage.getItem(archiveKey);
      if (archived !== null && archived !== raw) continue;
      if (archived === null) window.localStorage.setItem(archiveKey, raw);
      if (window.localStorage.getItem(archiveKey) !== raw) throw new Error("preservation failed");
      preserved = true;
      break;
    }
    if (!preserved || window.localStorage.getItem(key) !== raw)
      throw new Error("reset scope changed");
    window.localStorage.removeItem(key);
    if (window.localStorage.getItem(key) !== null) throw new Error("reset failed");
    if (recovering) clearUncertainty();
  } catch {
    throw new Error(
      "Could not preserve or reset this device's previous notification record. Retry Reset browser push when local storage is available.",
    );
  }
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function randomInstallationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Owned credentials can be created only by the explicit enable path. */
export function pwaPushInstallation(input?: { readonly explicitEnable: boolean }): Installation {
  const profile = requireProfile();
  if (profile.mode === "owned") {
    const stored = readRecord(profile.relayOrigin);
    if (stored) return stored.installation;
    if (
      !input?.explicitEnable ||
      window.localStorage.getItem(recordKey(profile.relayOrigin)) !== null
    )
      throw new PwaPushBindingError();
    const installation = {
      installationId: randomInstallationId(),
      installationSecret: randomSecret(),
    };
    writeRecord({ version: 1, relayOrigin: profile.relayOrigin, installation, subscription: null });
    return installation;
  }
  const storedId = window.localStorage.getItem(INSTALLATION_ID_KEY);
  const storedSecret = window.localStorage.getItem(INSTALLATION_SECRET_KEY);
  if (storedId && storedSecret)
    return { installationId: storedId, installationSecret: storedSecret };
  const installation = {
    installationId: randomInstallationId(),
    installationSecret: randomSecret(),
  };
  window.localStorage.setItem(INSTALLATION_ID_KEY, installation.installationId);
  window.localStorage.setItem(INSTALLATION_SECRET_KEY, installation.installationSecret);
  return installation;
}

/** Compare bytes, allowing equivalent padded/base64url public keys. Unknown keys fail closed. */
function pwaSubscriptionUsesKey(subscription: PushSubscription, key: string): boolean {
  try {
    const actual = subscription.options?.applicationServerKey;
    if (!actual) return false;
    const normalized = key.replaceAll("-", "+").replaceAll("_", "/");
    const expected = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = new Uint8Array(actual);
    return (
      bytes.length > 0 &&
      bytes.length === expected.length &&
      bytes.every((byte, i) => byte === expected.charCodeAt(i))
    );
  } catch {
    return false;
  }
}
function samePublicKey(left: string, right: string): boolean {
  try {
    const decode = (key: string) => {
      const base64 = key.replaceAll("-", "+").replaceAll("_", "/");
      return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    };
    return decode(left) === decode(right);
  } catch {
    return false;
  }
}
export function canSyncPwaPushSubscription(subscription: PushSubscription, key: string): boolean {
  const profile = getPwaPushRelayProfile();
  if (profile.type === "blocked") return false;
  if (profile.mode === "legacy") return pwaSubscriptionUsesKey(subscription, key);
  const record = readRecord(profile.relayOrigin);
  return Boolean(
    record?.subscription &&
    record.subscription.endpoint === subscription.endpoint &&
    samePublicKey(record.subscription.applicationServerKey, key) &&
    pwaSubscriptionUsesKey(subscription, key),
  );
}
export function getPwaPushSubscriptionId(): string | null {
  if (typeof window === "undefined") return null;
  const profile = getPwaPushRelayProfile();
  if (profile.type === "blocked") return null;
  return profile.mode === "legacy"
    ? window.localStorage.getItem(LEGACY_SUBSCRIPTION_KEY)
    : (readRecord(profile.relayOrigin)?.subscription?.subscriptionId ?? null);
}
export function hasPendingPwaPushCleanup(): boolean {
  try {
    return (
      typeof window !== "undefined" && window.localStorage.getItem(CLEANUP_PENDING_KEY) === "1"
    );
  } catch {
    return false;
  }
}
export function markPendingPwaPushCleanup(): void {
  try {
    window.localStorage.setItem(CLEANUP_PENDING_KEY, "1");
  } catch {
    /* Advisory persistence must not prevent local cleanup or its visible retry. */
  }
}
function authorityScope(profile: Extract<PwaPushRelayProfile, { type: "available" }>) {
  return `${profile.mode}:${profile.relayOrigin}`;
}
function removalMarkerKey(profile: Extract<PwaPushRelayProfile, { type: "available" }>) {
  return `${REMOVAL_MARKER_PREFIX}${encodeURIComponent(authorityScope(profile))}`;
}
function registrationMarkerKey(profile: Extract<PwaPushRelayProfile, { type: "available" }>) {
  return `${REGISTRATION_MARKER_PREFIX}${encodeURIComponent(authorityScope(profile))}`;
}
function registrationState(profile: Extract<PwaPushRelayProfile, { type: "available" }>) {
  const marker = window.localStorage.getItem(registrationMarkerKey(profile));
  if (marker === null) return "none";
  return activeRegistrationMarkers.get(authorityScope(profile)) === marker
    ? "pending"
    : "uncertain";
}
function removalState(profile: Extract<PwaPushRelayProfile, { type: "available" }>) {
  const scope = authorityScope(profile);
  const operation = pendingRemovals.get(scope);
  if (operation?.state === "pending") return "pending";
  try {
    if (window.localStorage.getItem(removalMarkerKey(profile)) !== null) return "uncertain";
    const currentInstallation =
      profile.mode === "owned"
        ? readRecord(profile.relayOrigin)?.installation
        : {
            installationId: window.localStorage.getItem(INSTALLATION_ID_KEY),
            installationSecret: window.localStorage.getItem(INSTALLATION_SECRET_KEY),
          };
    if (
      operation &&
      currentInstallation?.installationId === operation.installation.installationId &&
      currentInstallation.installationSecret === operation.installation.installationSecret
    )
      return "uncertain";
    if (operation) pendingRemovals.delete(scope);
    return "none";
  } catch {
    return "uncertain";
  }
}
/** Includes issued PUT uncertainty: a successful DELETE does not order an aborted server upsert. */
export function getPwaPushRemovalState(): "none" | "pending" | "uncertain" {
  const profile = getPwaPushRelayProfile();
  if (profile.type === "blocked") return "none";
  try {
    const removal = removalState(profile);
    if (removal !== "none") return removal;
    return registrationState(profile);
  } catch {
    return "uncertain";
  }
}
export function isPwaPushRemovalPending(): boolean {
  return getPwaPushRemovalState() !== "none";
}
function authoritySnapshot(
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
): string | null {
  return profile.mode === "owned"
    ? window.localStorage.getItem(recordKey(profile.relayOrigin))
    : JSON.stringify([
        window.localStorage.getItem(LEGACY_SUBSCRIPTION_KEY),
        window.localStorage.getItem(INSTALLATION_ID_KEY),
        window.localStorage.getItem(INSTALLATION_SECRET_KEY),
      ]);
}
function requireSubscription(subscriptionId: string) {
  const profile = requireProfile();
  if (getPwaPushSubscriptionId() !== subscriptionId) throw new PwaPushBindingError();
  return profile;
}
/** Forget only a successfully removed current record; foreign/legacy records are untouched. */
function forgetSubscription(
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
  id: string,
  snapshot: string | null,
  generation: number,
) {
  if (
    authoritySnapshot(profile) !== snapshot ||
    (registrationGenerations.get(authorityScope(profile)) ?? 0) !== generation
  )
    return;
  if (profile.mode === "legacy") {
    const current = getPwaPushRelayProfile();
    if (
      current.type !== "available" ||
      current.mode !== profile.mode ||
      current.relayOrigin !== profile.relayOrigin
    )
      return;
    if (window.localStorage.getItem(LEGACY_SUBSCRIPTION_KEY) === id)
      window.localStorage.removeItem(LEGACY_SUBSCRIPTION_KEY);
    return;
  }
  const record = readRecord(profile.relayOrigin);
  if (record?.subscription?.subscriptionId === id) writeRecord({ ...record, subscription: null });
}
async function json<T>(
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, profile.relayOrigin).toString(), {
      ...init,
      redirect: "error",
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error(
      "The notification service is temporarily unavailable. Try again when connected.",
    );
  }
  if (response.status === 429) {
    const rejection = await publicRelayRejection(response, profile);
    if (rejection) throw rejection;
    throw new Error(
      "The notification service is temporarily rate limited. Try again in 60 seconds.",
    );
  }
  if (response.status === 503) {
    const rejection = await publicRelayRejection(response, profile);
    if (rejection) throw rejection;
    throw new PwaPushUnavailableError();
  }
  if (response.status === 404) throw new PwaPushUnavailableError();
  if (!response.ok) throw new Error(`PWA push service returned ${response.status}.`);
  try {
    return (await response.json()) as T;
  } catch {
    throw new PwaPushUnavailableError();
  }
}
export async function getPwaPushConfig(): Promise<string> {
  const result = await json<{ applicationServerKey: string }>(
    requireProfile(),
    "/v1/pwa/web-push/config",
  );
  if (!result || typeof result.applicationServerKey !== "string" || !result.applicationServerKey)
    throw new PwaPushUnavailableError();
  return result.applicationServerKey;
}
function settleRejectedOperation(
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
  installation: Installation,
  snapshot: string | null,
  generation: number,
  markerKey: string,
  marker: string,
): boolean {
  try {
    const current = getPwaPushRelayProfile();
    if (
      current.type !== "available" ||
      current.mode !== profile.mode ||
      current.relayOrigin !== profile.relayOrigin
    )
      return false;
    const active =
      profile.mode === "owned"
        ? readRecord(profile.relayOrigin)?.installation
        : {
            installationId: window.localStorage.getItem(INSTALLATION_ID_KEY),
            installationSecret: window.localStorage.getItem(INSTALLATION_SECRET_KEY),
          };
    if (
      active?.installationId !== installation.installationId ||
      active.installationSecret !== installation.installationSecret ||
      authoritySnapshot(profile) !== snapshot ||
      (registrationGenerations.get(authorityScope(profile)) ?? 0) !== generation ||
      window.localStorage.getItem(markerKey) !== marker
    )
      return false;
    window.localStorage.removeItem(markerKey);
    return window.localStorage.getItem(markerKey) === null;
  } catch {
    return false;
  }
}

async function registerCurrentSubscription(input: {
  readonly environmentId: string;
  readonly subscription: PushSubscription;
  readonly preferences: RelayWebPushPreferences;
  readonly applicationServerKey: string;
  readonly explicitEnable?: boolean;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const profile = requireProfile();
  if (input.signal?.aborted) throw new Error("Notification setup was cancelled.");
  if (getPwaPushRemovalState() !== "none")
    throw new PwaPushRemovalPendingError(getPwaPushRemovalState() === "uncertain");
  if (
    !pwaSubscriptionUsesKey(input.subscription, input.applicationServerKey) ||
    (!input.explicitEnable &&
      !canSyncPwaPushSubscription(input.subscription, input.applicationServerKey))
  )
    throw new PwaPushBindingError();
  const serialized = input.subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!p256dh || !auth) throw new Error("This browser returned an invalid Web Push subscription.");
  const installation = pwaPushInstallation({ explicitEnable: input.explicitEnable === true });
  const scope = authorityScope(profile);
  const snapshot = authoritySnapshot(profile);
  const generation = registrationGenerations.get(scope) ?? 0;
  const markerKey = registrationMarkerKey(profile);
  const marker = JSON.stringify({
    installationId: installation.installationId,
    operationId: randomInstallationId(),
  });
  try {
    window.localStorage.setItem(markerKey, marker);
    if (window.localStorage.getItem(markerKey) !== marker) throw new Error("marker was not saved");
  } catch {
    throw new Error(
      "Could not save notification registration authority. No remote setup was sent.",
    );
  }
  activeRegistrationMarkers.set(scope, marker);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: (() => void) | undefined;
  // An issued PUT can outlive its fetch's abort/rejection. Keep its durable admission
  // fence unless this exact request has a validated response and unchanged authority.
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = () =>
        reject(
          new Error(
            "Notification setup was cancelled or timed out. In owned mode, use Reset browser push before renewal. Legacy credentials remain preserved until old service setup is confirmed.",
          ),
        );
      controller.signal.addEventListener("abort", rejectCancellation, { once: true });
      timer = setTimeout(cancel, 10_000);
    });
    const request = json<{ subscriptionId: string }>(profile, "/v1/pwa/web-push/subscriptions", {
      method: "PUT",
      signal: controller.signal,
      body: JSON.stringify({
        environmentId: input.environmentId,
        installation,
        endpoint: input.subscription.endpoint,
        keys: { p256dh, auth },
        preferences: input.preferences,
      }),
    });
    const result = await Promise.race([request, cancelled]);
    if (input.signal?.aborted) throw new Error("Notification setup was cancelled.");
    const current = requireProfile();
    if (current.mode !== profile.mode || current.relayOrigin !== profile.relayOrigin)
      throw new PwaPushBindingError();
    const activeInstallation =
      profile.mode === "owned"
        ? readRecord(profile.relayOrigin)?.installation
        : {
            installationId: window.localStorage.getItem(INSTALLATION_ID_KEY),
            installationSecret: window.localStorage.getItem(INSTALLATION_SECRET_KEY),
          };
    if (
      activeInstallation?.installationId !== installation.installationId ||
      activeInstallation.installationSecret !== installation.installationSecret ||
      authoritySnapshot(profile) !== snapshot ||
      (registrationGenerations.get(scope) ?? 0) !== generation ||
      window.localStorage.getItem(markerKey) !== marker
    )
      throw new PwaPushBindingError();
    if (!result || typeof result.subscriptionId !== "string" || !result.subscriptionId)
      throw new PwaPushUnavailableError();
    try {
      if (profile.mode === "legacy")
        window.localStorage.setItem(LEGACY_SUBSCRIPTION_KEY, result.subscriptionId);
      else
        writeRecord({
          version: 1,
          relayOrigin: profile.relayOrigin,
          installation,
          subscription: {
            subscriptionId: result.subscriptionId,
            endpoint: input.subscription.endpoint,
            applicationServerKey: input.applicationServerKey,
          },
        });
      registrationGenerations.set(scope, generation + 1);
      if (window.localStorage.getItem(markerKey) === marker)
        window.localStorage.removeItem(markerKey);
      if (window.localStorage.getItem(markerKey) !== null)
        throw new Error("completion was not saved");
    } catch {
      throw new Error(
        "Notification registration completion could not be saved. Renewal is blocked until setup is confirmed or owned authority is explicitly reset.",
      );
    }
    return result.subscriptionId;
  } catch (error) {
    if (
      error instanceof PwaPushRateLimitedError &&
      !controller.signal.aborted &&
      !input.signal?.aborted
    )
      settleRejectedOperation(profile, installation, snapshot, generation, markerKey, marker);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    if (rejectCancellation) controller.signal.removeEventListener("abort", rejectCancellation);
    if (activeRegistrationMarkers.get(scope) === marker) activeRegistrationMarkers.delete(scope);
  }
}
export function registerPwaPushSubscription(
  input: Parameters<typeof registerCurrentSubscription>[0],
): Promise<string> {
  try {
    const scope = authorityScope(requireProfile());
    if (getPwaPushRemovalState() !== "none")
      return Promise.reject(
        new PwaPushRemovalPendingError(getPwaPushRemovalState() === "uncertain"),
      );
    const registrations = pendingRegistrations.get(scope) ?? new Set<Promise<string>>();
    pendingRegistrations.set(scope, registrations);
    const pending = registerCurrentSubscription(input);
    registrations.add(pending);
    const completed = () => {
      registrations.delete(pending);
      if (registrations.size === 0 && pendingRegistrations.get(scope) === registrations)
        pendingRegistrations.delete(scope);
    };
    void pending.then(completed, completed);
    return pending;
  } catch (error) {
    return Promise.reject(error);
  }
}
export function removePwaPushSubscription(subscriptionId: string): Promise<void> {
  try {
    const profile = requireSubscription(subscriptionId);
    const scope = authorityScope(profile);
    const existing = pendingRemovals.get(scope);
    if (existing?.state === "pending") return existing.promise;
    if (removalState(profile) === "uncertain")
      return Promise.reject(new PwaPushRemovalPendingError(true));
    const installation = pwaPushInstallation();
    const snapshot = authoritySnapshot(profile);
    const generation = registrationGenerations.get(scope) ?? 0;
    const priorRegistrations = [...(pendingRegistrations.get(scope) ?? [])];
    const markerKey = removalMarkerKey(profile);
    const marker = JSON.stringify({
      installationId: installation.installationId,
      operationId: randomInstallationId(),
    });
    try {
      window.localStorage.setItem(markerKey, marker);
      if (window.localStorage.getItem(markerKey) !== marker)
        throw new Error("marker was not saved");
    } catch {
      return Promise.reject(
        new Error(
          "Could not save remote cleanup authority. Local Disable or Reset remains available.",
        ),
      );
    }
    const operation: RemovalOperation = {
      state: "pending",
      promise: Promise.resolve(),
      installation,
    };
    const pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removalStarted = false;
      try {
        // Relay APIs have a 9s deadline. The 10s client lifetime bounds resources, but
        // an abort never proves server SQL stopped: retain uncertainty until explicit recovery.
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new PwaPushRemovalPendingError(true));
          }, 10_000);
        });
        const cleanup = async () => {
          if (priorRegistrations.length > 0) await Promise.allSettled(priorRegistrations);
          if (controller.signal.aborted) throw new PwaPushRemovalPendingError(true);
          if (
            authoritySnapshot(profile) !== snapshot ||
            (registrationGenerations.get(scope) ?? 0) !== generation
          )
            throw new PwaPushBindingError();
          removalStarted = true;
          return json(
            profile,
            `/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/remove`,
            {
              method: "POST",
              signal: controller.signal,
              body: JSON.stringify({ installation }),
            },
          );
        };
        await Promise.race([cleanup(), deadline]);
        // DELETE acknowledges only deletion. A prior rejected PUT may still upsert
        // afterward; retain exact authority and its separate registration fence.
        if (registrationState(profile) === "none")
          forgetSubscription(profile, subscriptionId, snapshot, generation);
        if (window.localStorage.getItem(markerKey) === marker)
          window.localStorage.removeItem(markerKey);
        if (pendingRemovals.get(scope) === operation) pendingRemovals.delete(scope);
      } catch (error) {
        if (
          error instanceof PwaPushRateLimitedError &&
          !controller.signal.aborted &&
          settleRejectedOperation(profile, installation, snapshot, generation, markerKey, marker)
        ) {
          if (pendingRemovals.get(scope) === operation) pendingRemovals.delete(scope);
        } else if (!removalStarted && !controller.signal.aborted) {
          if (window.localStorage.getItem(markerKey) === marker)
            window.localStorage.removeItem(markerKey);
          if (pendingRemovals.get(scope) === operation) pendingRemovals.delete(scope);
        } else operation.state = "uncertain";
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    operation.promise = pending;
    pendingRemovals.set(scope, operation);
    return pending;
  } catch (error) {
    return Promise.reject(error);
  }
}

export async function testPwaPushSubscription(subscriptionId: string): Promise<void> {
  const profile = requireSubscription(subscriptionId);
  await json(profile, `/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: "POST",
    body: JSON.stringify({ installation: pwaPushInstallation() }),
  });
}
