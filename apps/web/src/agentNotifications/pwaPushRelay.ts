import type { RelayWebPushPreferences } from "@t3tools/contracts/relay";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";

const INSTALLATION_ID_KEY = "t3code.pwaPushInstallationId";
const INSTALLATION_SECRET_KEY = "t3code.pwaPushInstallationSecret";
const LEGACY_SUBSCRIPTION_KEY = "t3code.webPushSubscriptionId";
const CLEANUP_PENDING_KEY = "t3code.pwaPushCleanupPending.v1";
const SCOPED_RECORD_PREFIX = "t3code.pwaPushAuthority.v1:";

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
export class PwaPushBindingError extends Error {
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

/** Explicit Reset only: preserve exact private bytes before freeing an invalid current slot. */
export function resetMalformedPwaPushAuthority(expectedProfile: PwaPushRelayProfile): void {
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
    if (raw === null || readRecord(current.relayOrigin)) return;
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
export function pwaSubscriptionUsesKey(subscription: PushSubscription, key: string): boolean {
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
function requireSubscription(subscriptionId: string) {
  const profile = requireProfile();
  if (getPwaPushSubscriptionId() !== subscriptionId) throw new PwaPushBindingError();
  return profile;
}
/** Forget only a successfully removed current record; foreign/legacy records are untouched. */
function forgetSubscription(
  profile: Extract<PwaPushRelayProfile, { type: "available" }>,
  id: string,
) {
  if (profile.mode === "legacy") {
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
  if (response.status === 404 || response.status === 503) throw new PwaPushUnavailableError();
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
export async function registerPwaPushSubscription(input: {
  readonly environmentId: string;
  readonly subscription: PushSubscription;
  readonly preferences: RelayWebPushPreferences;
  readonly applicationServerKey: string;
  readonly explicitEnable?: boolean;
  readonly signal?: AbortSignal | undefined;
}): Promise<string> {
  const profile = requireProfile();
  if (input.signal?.aborted) throw new Error("Notification setup was cancelled.");
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
  const result = await json<{ subscriptionId: string }>(profile, "/v1/pwa/web-push/subscriptions", {
    method: "PUT",
    ...(input.signal ? { signal: input.signal } : {}),
    body: JSON.stringify({
      environmentId: input.environmentId,
      installation,
      endpoint: input.subscription.endpoint,
      keys: { p256dh, auth },
      preferences: input.preferences,
    }),
  });
  if (input.signal?.aborted) throw new Error("Notification setup was cancelled.");
  const current = requireProfile();
  if (current.mode !== profile.mode || current.relayOrigin !== profile.relayOrigin)
    throw new PwaPushBindingError();
  if (!result || typeof result.subscriptionId !== "string" || !result.subscriptionId)
    throw new PwaPushUnavailableError();
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
  return result.subscriptionId;
}
export async function removePwaPushSubscription(subscriptionId: string): Promise<void> {
  const profile = requireSubscription(subscriptionId);
  await json(
    profile,
    `/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/remove`,
    {
      method: "POST",
      body: JSON.stringify({ installation: pwaPushInstallation() }),
    },
  );
  forgetSubscription(profile, subscriptionId);
}
export async function testPwaPushSubscription(subscriptionId: string): Promise<void> {
  const profile = requireSubscription(subscriptionId);
  await json(profile, `/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: "POST",
    body: JSON.stringify({ installation: pwaPushInstallation() }),
  });
}
