import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canSyncPwaPushSubscription,
  getPwaPushConfig,
  getPwaPushRelayProfile,
  isPwaPushAuthorityResetRequired,
  resetMalformedPwaPushAuthority,
  getPwaPushSubscriptionId,
  pwaPushInstallation,
  registerPwaPushSubscription,
  removePwaPushSubscription,
  testPwaPushSubscription,
} from "./pwaPushRelay";

const values = new Map<string, string>();
const fetchMock = vi.fn();
const preferences = {
  enabled: true,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  showProjectAndThreadNames: false,
};
function owned(origin = "https://relay.example.test") {
  vi.stubEnv("VITE_CONNECT_MODE", "owned");
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("issuer.example.test$")}`);
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright");
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client-test");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", origin);
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://app.example.test");
}
function subscription(
  key = "AQID",
  endpoint = "https://push.example.test/device",
): PushSubscription {
  return {
    endpoint,
    expirationTime: null,
    getKey: () => null,
    unsubscribe: async () => true,
    options: {
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(key), (c) => c.charCodeAt(0)).buffer,
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "public-key", auth: "auth-key" } }),
  } satisfies PushSubscription;
}
function register(explicitEnable = true, sub: PushSubscription = subscription(), key = "AQID") {
  return registerPwaPushSubscription({
    environmentId: "environment-1",
    subscription: sub,
    preferences,
    applicationServerKey: key,
    explicitEnable,
  });
}
beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ subscriptionId: "subscription-1", applicationServerKey: "AQID" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  owned();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PWA push relay authority", () => {
  it.each(["cloudless", "invalid-owned"])(
    "makes zero HTTP requests and preserves old records in %s",
    async (mode) => {
      values.set("t3code.pwaPushInstallationId", "old-installation");
      values.set("t3code.pwaPushInstallationSecret", "old-secret");
      values.set("t3code.webPushSubscriptionId", "old-subscription");
      const before = [...values];
      if (mode === "cloudless") vi.stubEnv("VITE_CONNECT_MODE", "cloudless");
      else vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://unsafe.example.test");
      expect(getPwaPushRelayProfile().type).toBe("blocked");
      expect(() => pwaPushInstallation({ explicitEnable: true })).toThrow(/unavailable/);
      await expect(getPwaPushConfig()).rejects.toThrow(/unavailable/);
      await expect(register()).rejects.toThrow(/unavailable/);
      await expect(removePwaPushSubscription("old-subscription")).rejects.toThrow(/unavailable/);
      await expect(testPwaPushSubscription("old-subscription")).rejects.toThrow(/unavailable/);
      expect(getPwaPushSubscriptionId()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect([...values]).toEqual(before);
    },
  );
  it("never adopts global/unbound credentials or subscription IDs in owned mode", async () => {
    values.set("t3code.pwaPushInstallationId", "old-installation");
    values.set("t3code.pwaPushInstallationSecret", "old-secret");
    values.set("t3code.webPushSubscriptionId", "old-subscription");
    const before = [...values];
    expect(() => pwaPushInstallation()).toThrow(/Reset/);
    await expect(register(false)).rejects.toThrow(/Reset/);
    await expect(removePwaPushSubscription("old-subscription")).rejects.toThrow(/Reset/);
    await expect(testPwaPushSubscription("old-subscription")).rejects.toThrow(/Reset/);
    await getPwaPushConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...values]).toEqual(before);
    await register();
    expect(pwaPushInstallation().installationId).not.toBe("old-installation");
    expect(values.get("t3code.pwaPushInstallationSecret")).toBe("old-secret");
    expect(values.get("t3code.webPushSubscriptionId")).toBe("old-subscription");
  });
  it("creates one stable anonymous identity for the normalized selected origin only on explicit enable", async () => {
    expect(values.size).toBe(0);
    await getPwaPushConfig();
    expect(values.size).toBe(0);
    await register();
    const first = pwaPushInstallation();
    owned("https://RELAY.example.test:443/");
    expect(pwaPushInstallation()).toEqual(first);
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.installationSecret).not.toBe("");
    expect(canSyncPwaPushSubscription(subscription(), "AQID")).toBe(true);
    await register(false);
    await testPwaPushSubscription("subscription-1");
    await removePwaPushSubscription("subscription-1");
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(new URL(url).origin).toBe("https://relay.example.test");
      expect(JSON.parse(init.body).installation).toEqual(first);
      expect(init.redirect).toBe("error");
    }
    expect(getPwaPushSubscriptionId()).toBeNull();
  });
  it("blocks foreign realm removal, test and automatic registration before HTTP, then enrolls fresh explicitly", async () => {
    await register();
    const first = pwaPushInstallation();
    const before = [...values];
    fetchMock.mockClear();
    owned("https://other.example.test");
    expect(getPwaPushSubscriptionId()).toBeNull();
    expect(canSyncPwaPushSubscription(subscription(), "AQID")).toBe(false);
    await expect(register(false)).rejects.toThrow(/Reset/);
    await expect(removePwaPushSubscription("subscription-1")).rejects.toThrow(/Reset/);
    await expect(testPwaPushSubscription("subscription-1")).rejects.toThrow(/Reset/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...values]).toEqual(before);
    await register(true, subscription("AQID", "https://push.example.test/new-device"));
    expect(pwaPushInstallation()).not.toEqual(first);
    for (const [key, value] of before) expect(values.get(key)).toBe(value);
  });
  it.each(["key", "endpoint", "missing-key"])(
    "blocks automatic registration of a %s mismatch without altering saved authority",
    async (mismatch) => {
      await register();
      const before = [...values];
      fetchMock.mockClear();
      const sub =
        mismatch === "key"
          ? subscription("BAUG")
          : mismatch === "endpoint"
            ? subscription("AQID", "https://push.example.test/other")
            : { ...subscription(), options: { userVisibleOnly: true, applicationServerKey: null } };
      expect(canSyncPwaPushSubscription(sub, "AQID")).toBe(false);
      await expect(register(false, sub)).rejects.toThrow(/Reset/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect([...values]).toEqual(before);
    },
  );
  it("rejects direct explicit registration with an incompatible browser VAPID key before credential creation", async () => {
    await expect(register(true, subscription("BAUG"))).rejects.toThrow(/Reset/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });
  it("preserves registration and credentials on offline removal and returns a bounded error", async () => {
    await register();
    const before = [...values];
    fetchMock.mockRejectedValue(new Error("https://sensitive.example/private-secret"));
    await expect(removePwaPushSubscription("subscription-1")).rejects.toThrow(
      "The notification service is temporarily unavailable. Try again when connected.",
    );
    expect([...values]).toEqual(before);
  });
  it.each([404, 503])(
    "reports a disabled anonymous push capability (%s) without creating credentials",
    async (status) => {
      fetchMock.mockResolvedValue({ ok: false, status });
      await expect(getPwaPushConfig()).rejects.toThrow(/unavailable for this Connect profile/);
      expect(values.size).toBe(0);
    },
  );
  it("rejects a malformed saved current record without HTTP or overwriting it", async () => {
    const key = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
    values.set(
      key,
      JSON.stringify({
        version: 1,
        relayOrigin: "https://foreign.example.test",
        installation: { installationId: "foreign", installationSecret: "foreign" },
        subscription: null,
      }),
    );
    const before = [...values];
    await expect(register(false)).rejects.toThrow(/Reset/);
    await expect(testPwaPushSubscription("foreign")).rejects.toThrow(/Reset/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...values]).toEqual(before);
  });
  it("keeps deliberate legacy fallback and stable global anonymous credentials", async () => {
    vi.stubEnv("VITE_CONNECT_MODE", "legacy");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    values.set("t3code.pwaPushInstallationId", "legacy-installation");
    values.set("t3code.pwaPushInstallationSecret", "legacy-secret");
    values.set("t3code.webPushSubscriptionId", "subscription-1");
    await register(false);
    await testPwaPushSubscription("subscription-1");
    expect(pwaPushInstallation()).toEqual({
      installationId: "legacy-installation",
      installationSecret: "legacy-secret",
    });
    expect(
      fetchMock.mock.calls.every(([url]) => new URL(url).origin === "https://relay.t3.codes"),
    ).toBe(true);
    expect(values.size).toBe(3);
  });
});
it("preserves a foreign record stored under the current key even during explicit enrollment", async () => {
  const key = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
  values.set(
    key,
    JSON.stringify({
      version: 1,
      relayOrigin: "https://foreign.example.test",
      installation: { installationId: "foreign", installationSecret: "foreign" },
      subscription: null,
    }),
  );
  const before = [...values];
  await expect(register()).rejects.toThrow(/Reset/);
  expect(fetchMock).not.toHaveBeenCalled();
  expect([...values]).toEqual(before);
});
it("does not persist a late registration response after cancellation", async () => {
  await register();
  const before = [...values];
  let resolveResponse: (value: object) => void = () => {};
  fetchMock.mockReturnValue(
    new Promise((resolve) => {
      resolveResponse = resolve;
    }),
  );
  const controller = new AbortController();
  const pending = registerPwaPushSubscription({
    environmentId: "environment-1",
    subscription: subscription(),
    preferences,
    applicationServerKey: "AQID",
    signal: controller.signal,
  });
  controller.abort();
  resolveResponse({
    ok: true,
    status: 200,
    json: async () => ({ subscriptionId: "late-subscription" }),
  });
  await expect(pending).rejects.toThrow(/cancelled/);
  expect([...values]).toEqual(before);
});
it("accepts equivalent padded/base64url VAPID keys for a bound subscription", async () => {
  await register(true, subscription("AQI="), "AQI=");
  expect(canSyncPwaPushSubscription(subscription("AQI="), "AQI")).toBe(true);
  await expect(register(false, subscription("AQI="), "AQI")).resolves.toBe("subscription-1");
});
const currentSlot = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
it("never changes an occupied invalid authority slot during inspection, then explicit reset preserves exact bytes", async () => {
  const raw = '{invalid-json\n"secret": "private-recovery-value"';
  values.set(currentSlot, raw);
  const before = [...values];
  expect(isPwaPushAuthorityResetRequired()).toBe(true);
  await expect(register()).rejects.toThrow(/Reset/);
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
  resetMalformedPwaPushAuthority(getPwaPushRelayProfile());
  expect(values.has(currentSlot)).toBe(false);
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe(raw);
  expect(isPwaPushAuthorityResetRequired()).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  await register();
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe(raw);
});
it.each(["throw", "silently-refused"])(
  "does not clear the original when quarantine storage is %s",
  (failure) => {
    const raw = "private-invalid-record";
    values.set(currentSlot, raw);
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const storageFailure = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        if (key.startsWith(`${currentSlot}:quarantine:`)) {
          if (failure === "throw") throw new Error(raw);
          return;
        }
        setItem(key, value);
      });
    expect(() => resetMalformedPwaPushAuthority(getPwaPushRelayProfile())).toThrow(
      "Could not preserve or reset this device's previous notification record. Retry Reset browser push when local storage is available.",
    );
    expect(values.get(currentSlot)).toBe(raw);
    expect(isPwaPushAuthorityResetRequired()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    storageFailure.mockRestore();
  },
);
it("refuses a full bounded quarantine without overwriting any old private record", () => {
  values.set(currentSlot, "current-invalid");
  for (let index = 0; index < 16; index += 1)
    values.set(`${currentSlot}:quarantine:${index}`, `private-archive-${index}`);
  const before = [...values];
  expect(() => resetMalformedPwaPushAuthority(getPwaPushRelayProfile())).toThrow(
    /Could not preserve/,
  );
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("reuses an identical durable quarantine copy and preserves other occupied slots", () => {
  const raw = "same-invalid-record";
  values.set(currentSlot, raw);
  values.set(`${currentSlot}:quarantine:0`, "previous-private-record");
  values.set(`${currentSlot}:quarantine:1`, raw);
  const foreignKey = "t3code.pwaPushAuthority.v1:https%3A%2F%2Fother.example.test";
  values.set(foreignKey, "foreign-private-record");
  resetMalformedPwaPushAuthority(getPwaPushRelayProfile());
  expect(values.has(currentSlot)).toBe(false);
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe("previous-private-record");
  expect(values.get(`${currentSlot}:quarantine:1`)).toBe(raw);
  expect(values.get(foreignKey)).toBe("foreign-private-record");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("leaves valid current authority intact during explicit malformed-slot reset", async () => {
  await register();
  const before = [...values];
  fetchMock.mockClear();
  expect(isPwaPushAuthorityResetRequired()).toBe(false);
  resetMalformedPwaPushAuthority(getPwaPushRelayProfile());
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("a delayed reset cannot quarantine a newly selected profile's slot", () => {
  values.set(currentSlot, "old-invalid");
  const oldProfile = getPwaPushRelayProfile();
  owned("https://other.example.test");
  values.set("t3code.pwaPushAuthority.v1:https%3A%2F%2Fother.example.test", "new-invalid");
  const before = [...values];
  expect(() => resetMalformedPwaPushAuthority(oldProfile)).toThrow(/Reset/);
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
});
