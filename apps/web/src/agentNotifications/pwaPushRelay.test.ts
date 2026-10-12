import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canSyncPwaPushSubscription,
  getPwaPushConfig,
  getPwaPushRelayProfile,
  isPwaPushAuthorityResetRequired,
  isPwaPushRemovalPending,
  getPwaPushRemovalState,
  resetPwaPushAuthority,
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
  vi.useRealTimers();
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
    for (const [key, value] of before) expect(values.get(key)).toBe(value);
    expect(getPwaPushRemovalState()).toBe("uncertain");
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
  for (const [key, value] of before) expect(values.get(key)).toBe(value);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  fetchMock.mockClear();
  await expect(register()).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).not.toHaveBeenCalled();
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
  resetPwaPushAuthority(getPwaPushRelayProfile());
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
    expect(() => resetPwaPushAuthority(getPwaPushRelayProfile())).toThrow(
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
  expect(() => resetPwaPushAuthority(getPwaPushRelayProfile())).toThrow(/Could not preserve/);
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
  resetPwaPushAuthority(getPwaPushRelayProfile());
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
  resetPwaPushAuthority(getPwaPushRelayProfile());
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("a delayed reset cannot quarantine a newly selected profile's slot", () => {
  values.set(currentSlot, "old-invalid");
  const oldProfile = getPwaPushRelayProfile();
  owned("https://other.example.test");
  values.set("t3code.pwaPushAuthority.v1:https%3A%2F%2Fother.example.test", "new-invalid");
  const before = [...values];
  expect(() => resetPwaPushAuthority(oldProfile)).toThrow(/Reset/);
  expect([...values]).toEqual(before);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("coalesces current-authority removals and blocks replacement enrollment until actual completion", async () => {
  await register();
  let resolveRemove: (value: object) => void = () => {};
  fetchMock.mockClear().mockReturnValue(
    new Promise((resolve) => {
      resolveRemove = resolve;
    }),
  );
  const first = removePwaPushSubscription("subscription-1");
  const second = removePwaPushSubscription("subscription-1");
  expect(second).toBe(first);
  expect(isPwaPushRemovalPending()).toBe(true);
  await expect(register()).rejects.toThrow(/cleanup is still pending/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolveRemove({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await first;
  expect(isPwaPushRemovalPending()).toBe(false);
  expect(getPwaPushSubscriptionId()).toBeNull();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ subscriptionId: "subscription-1" }),
  });
  await register();
  expect(getPwaPushSubscriptionId()).toBe("subscription-1");
});
it("a late removal does not erase a changed same-ID authority record", async () => {
  await register();
  let resolveRemove: (value: object) => void = () => {};
  fetchMock.mockReturnValue(
    new Promise((resolve) => {
      resolveRemove = resolve;
    }),
  );
  const pending = removePwaPushSubscription("subscription-1");
  const newer = JSON.parse(values.get(currentSlot)!);
  newer.subscription.endpoint = "https://push.example.test/replacement";
  const replacement = JSON.stringify(newer);
  values.set(currentSlot, replacement);
  resolveRemove({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await pending;
  expect(values.get(currentSlot)).toBe(replacement);
  expect(getPwaPushSubscriptionId()).toBe("subscription-1");
});
it("a same-ID registration already in flight cannot be deleted by a stale cleanup intent", async () => {
  await register();
  let resolveRegister: (value: object) => void = () => {};
  fetchMock.mockClear().mockReturnValue(
    new Promise((resolve) => {
      resolveRegister = resolve;
    }),
  );
  const registering = register();
  const removing = removePwaPushSubscription("subscription-1");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  resolveRegister({
    ok: true,
    status: 200,
    json: async () => ({ subscriptionId: "subscription-1" }),
  });
  await registering;
  await expect(removing).rejects.toThrow(/Reset/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getPwaPushSubscriptionId()).toBe("subscription-1");
  expect(isPwaPushRemovalPending()).toBe(false);
});
it("timeout keeps uncertain deletion authority until explicit owned Reset preserves and rotates it", async () => {
  vi.useFakeTimers();
  await register();
  const oldInstallation = pwaPushInstallation();
  const oldRecord = values.get(currentSlot)!;
  let resolveLateRemoval: (value: object) => void = () => {};
  fetchMock.mockReturnValue(
    new Promise((resolve) => {
      resolveLateRemoval = resolve;
    }),
  );
  const removal = removePwaPushSubscription("subscription-1");
  const failure = expect(removal).rejects.toThrow(/uncertain outcome/);
  await vi.advanceTimersByTimeAsync(10_000);
  await failure;
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(values.get(currentSlot)).toBe(oldRecord);
  const requestCount = fetchMock.mock.calls.length;
  await expect(register()).rejects.toThrow(/uncertain outcome/);
  await expect(removePwaPushSubscription("subscription-1")).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  resetPwaPushAuthority(getPwaPushRelayProfile());
  expect([...values.values()]).toContain(oldRecord);
  expect(getPwaPushRemovalState()).toBe("none");
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ subscriptionId: "subscription-1" }),
  });
  await register();
  expect(pwaPushInstallation()).not.toEqual(oldInstallation);
  const replacement = values.get(currentSlot);
  resolveLateRemoval({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await Promise.resolve();
  expect(values.get(currentSlot)).toBe(replacement);
  expect(getPwaPushSubscriptionId()).toBe("subscription-1");
  vi.useRealTimers();
});
it("persisted uncertain owned removal requires explicit recovery across a runtime reload", async () => {
  await register();
  const installation = pwaPushInstallation();
  const raw = values.get(currentSlot)!;
  values.set(
    "t3code.pwaPushRemovalPending.v1:owned%3Ahttps%3A%2F%2Frelay.example.test",
    JSON.stringify({
      installationId: installation.installationId,
      operationId: "previous-runtime",
    }),
  );
  fetchMock.mockClear();
  expect(getPwaPushRemovalState()).toBe("uncertain");
  await expect(register()).rejects.toThrow(/uncertain outcome/);
  await expect(removePwaPushSubscription("subscription-1")).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).not.toHaveBeenCalled();
  resetPwaPushAuthority(getPwaPushRelayProfile());
  expect([...values.values()]).toContain(raw);
  await register();
  expect(pwaPushInstallation()).not.toEqual(installation);
});
it("legacy uncertain removal preserves old global keys and never silently rotates credentials", async () => {
  vi.stubEnv("VITE_CONNECT_MODE", "legacy");
  await register();
  const old = pwaPushInstallation();
  values.set(
    "t3code.pwaPushRemovalPending.v1:legacy%3Ahttps%3A%2F%2Frelay.example.test",
    "previous-runtime-uncertainty",
  );
  const before = [...values];
  fetchMock.mockClear();
  resetPwaPushAuthority(getPwaPushRelayProfile());
  await expect(register()).rejects.toThrow(/Legacy credentials are preserved/);
  expect([...values]).toEqual(before);
  expect(pwaPushInstallation()).toEqual(old);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("uncertainty recovery cannot discard active authority when preserving the old record fails", async () => {
  await register();
  values.set(
    "t3code.pwaPushRemovalPending.v1:owned%3Ahttps%3A%2F%2Frelay.example.test",
    "unconfirmed-cleanup",
  );
  const before = [...values];
  const setItem = window.localStorage.setItem.bind(window.localStorage);
  const storageFailure = vi
    .spyOn(window.localStorage, "setItem")
    .mockImplementation((key, value) => {
      if (key.startsWith(`${currentSlot}:quarantine:`)) throw new Error("storage full");
      setItem(key, value);
    });
  expect(() => resetPwaPushAuthority(getPwaPushRelayProfile())).toThrow(/Could not preserve/);
  expect([...values]).toEqual(before);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  const count = fetchMock.mock.calls.length;
  await expect(register()).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).toHaveBeenCalledTimes(count);
  storageFailure.mockRestore();
});

const registrationSlot =
  "t3code.pwaPushRegistrationPending.v1:owned%3Ahttps%3A%2F%2Frelay.example.test";
it.each(["throw", "not-durable"])(
  "registration admission must be saved before HTTP (%s)",
  async (failure) => {
    await register();
    const raw = values.get(currentSlot);
    const setItem = window.localStorage.setItem.bind(window.localStorage);
    const storageFailure = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        if (key === registrationSlot) {
          if (failure === "throw") throw new Error("private-storage-value");
          return;
        }
        setItem(key, value);
      });
    fetchMock.mockClear();
    await expect(register()).rejects.toThrow("Could not save notification registration authority");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values.get(currentSlot)).toBe(raw);
    storageFailure.mockRestore();
  },
);
it("a validated matching registration clears only its admission and preserves stable identity", async () => {
  await register();
  const installation = pwaPushInstallation();
  let resolvePut: (value: object) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePut = resolve;
    }),
  );
  const pending = register();
  const marker = values.get(registrationSlot)!;
  expect(JSON.parse(marker).installationId).toBe(installation.installationId);
  expect(marker).not.toContain(installation.installationSecret);
  expect(getPwaPushRemovalState()).toBe("pending");
  resolvePut({ ok: true, status: 200, json: async () => ({ subscriptionId: "subscription-1" }) });
  await pending;
  expect(values.has(registrationSlot)).toBe(false);
  expect(getPwaPushRemovalState()).toBe("none");
  await register();
  expect(pwaPushInstallation()).toEqual(installation);
});
it("failed completion persistence retains the registration fence after a validated response", async () => {
  await register();
  const removeItem = window.localStorage.removeItem.bind(window.localStorage);
  const storageFailure = vi.spyOn(window.localStorage, "removeItem").mockImplementation((key) => {
    if (key === registrationSlot) throw new Error("private-storage-value");
    removeItem(key);
  });
  await expect(register()).rejects.toThrow(
    "Notification registration completion could not be saved",
  );
  expect(getPwaPushRemovalState()).toBe("uncertain");
  const raw = values.get(currentSlot)!;
  fetchMock.mockClear();
  await expect(register()).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).not.toHaveBeenCalled();
  storageFailure.mockRestore();
  resetPwaPushAuthority(getPwaPushRelayProfile());
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe(raw);
  expect(getPwaPushRemovalState()).toBe("none");
});
it("a failed legacy registration preserves global identity and cannot be rotated by owned Reset", async () => {
  vi.stubEnv("VITE_CONNECT_MODE", "legacy");
  await register();
  const installation = pwaPushInstallation();
  const globals = [...values];
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  await expect(register()).rejects.toThrow(/temporarily unavailable/);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  await removePwaPushSubscription("subscription-1");
  for (const [key, value] of globals) expect(values.get(key)).toBe(value);
  resetPwaPushAuthority(getPwaPushRelayProfile());
  fetchMock.mockClear();
  await expect(register()).rejects.toThrow(/Legacy credentials are preserved/);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(pwaPushInstallation()).toEqual(installation);
});
it.each(["malformed", "unavailable"])(
  "an unvalidated %s registration response retains admission",
  async (failure) => {
    await register();
    const raw = values.get(currentSlot);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: failure === "unavailable" ? 503 : 200,
      json: async () => ({ subscriptionId: null }),
    });
    await expect(register()).rejects.toThrow(/unavailable/);
    expect(values.get(currentSlot)).toBe(raw);
    expect(getPwaPushRemovalState()).toBe("uncertain");
    fetchMock.mockClear();
    await expect(register()).rejects.toThrow(/uncertain outcome/);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it("a response after profile change preserves the old realm fence and cannot affect new authority", async () => {
  await register();
  const raw = values.get(currentSlot)!;
  let resolveOld: (value: object) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const oldRequest = register();
  owned("https://other.example.test");
  await register();
  const otherSlot = "t3code.pwaPushAuthority.v1:https%3A%2F%2Fother.example.test";
  const other = values.get(otherSlot);
  resolveOld({ ok: true, status: 200, json: async () => ({ subscriptionId: "late-old" }) });
  await expect(oldRequest).rejects.toThrow(/Reset/);
  expect(values.get(currentSlot)).toBe(raw);
  expect(values.get(otherSlot)).toBe(other);
  expect(getPwaPushRemovalState()).toBe("none");
  owned();
  expect(getPwaPushRemovalState()).toBe("uncertain");
  resetPwaPushAuthority(getPwaPushRelayProfile());
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe(raw);
  expect(values.get(otherSlot)).toBe(other);
});
it("a reload fences persisted registration admission and old acknowledged work cannot clear replacement authority", async () => {
  await register();
  const raw = values.get(currentSlot)!;
  const installation = pwaPushInstallation();
  let resolveOld: (value: object) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const oldRequest = register();
  vi.resetModules();
  const fresh = await import("./pwaPushRelay");
  expect(fresh.getPwaPushRemovalState()).toBe("uncertain");
  const count = fetchMock.mock.calls.length;
  await expect(
    fresh.registerPwaPushSubscription({
      environmentId: "environment-1",
      subscription: subscription(),
      preferences,
      applicationServerKey: "AQID",
      explicitEnable: true,
    }),
  ).rejects.toThrow(/uncertain outcome/);
  expect(fetchMock).toHaveBeenCalledTimes(count);
  fresh.resetPwaPushAuthority(fresh.getPwaPushRelayProfile());
  expect(values.get(`${currentSlot}:quarantine:0`)).toBe(raw);
  const input = {
    environmentId: "environment-1",
    subscription: subscription("AQID", "https://push.example.test/replacement"),
    preferences,
    applicationServerKey: "AQID",
    explicitEnable: true,
  };
  await fresh.registerPwaPushSubscription(input);
  expect(fresh.pwaPushInstallation()).not.toEqual(installation);
  let resolveNew: (value: object) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveNew = resolve;
    }),
  );
  const newRequest = fresh.registerPwaPushSubscription(input);
  const replacement = [...values];
  resolveOld({ ok: true, status: 200, json: async () => ({ subscriptionId: "subscription-1" }) });
  await expect(oldRequest).rejects.toThrow(/Reset/);
  expect([...values]).toEqual(replacement);
  expect(fresh.getPwaPushRemovalState()).toBe("pending");
  resolveNew({ ok: true, status: 200, json: async () => ({ subscriptionId: "subscription-1" }) });
  await newRequest;
  expect(fresh.getPwaPushRemovalState()).toBe("none");
});
