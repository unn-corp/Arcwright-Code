import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AgentNotificationPreferences } from "@t3tools/contracts";
import { PwaNotificationSettings } from "./AgentNotificationSettings";
import {
  registerPwaPushSubscription,
  getPwaPushSubscriptionId,
  getPwaPushRemovalState,
} from "../../agentNotifications/pwaPushRelay";

const fixture = vi.hoisted(() => ({
  settings: {
    agentNotifications: {
      enabled: false,
      notifyOnCompletion: true,
      notifyOnPlanReady: true,
      notifyOnInput: true,
      notifyOnFailure: true,
      showProjectAndThreadNames: true,
    },
  },
  listeners: new Set<() => void>(),
  environment: { environmentId: "environment-1" },
  update: vi.fn(),
  toast: vi.fn(),
  worker: vi.fn(),
  activeWorker: vi.fn(),
}));
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useClientSettings: (select: (settings: typeof fixture.settings) => unknown) => {
      const settings = useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => {
            fixture.listeners.delete(listener);
          };
        },
        () => fixture.settings,
      );
      return select(settings);
    },
    updateClientSettings: fixture.update,
  };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => fixture.environment }));
vi.mock("../../agentNotifications/sound", () => ({
  agentNotificationSoundLabel: () => "None",
  playAgentNotificationSoundId: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../pwa", () => ({
  registerPwaServiceWorker: fixture.worker,
  getActivePwaServiceWorkerRegistration: fixture.activeWorker,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: fixture.toast },
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
vi.mock("../ui/switch", () => ({ Switch: (props: object) => <input {...props} /> }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control }: { control: React.ReactNode }) => <>{control}</>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const values = new Map<string, string>();
const operations: string[] = [];
let existing: PushSubscription | null;
let renderer: ReactTestRenderer;
const fetchMock = vi.fn();
const unsubscribe = vi.fn();
const subscribe = vi.fn();
const getSubscription = vi.fn();
const preview = vi.fn();
let browser: EventTarget;
const pushKey = "AQID";
function owned(origin = "https://relay.example.test") {
  vi.stubEnv("VITE_CONNECT_MODE", "owned");
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_test_${btoa("issuer.example.test$")}`);
  vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "arcwright");
  vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "client-test");
  vi.stubEnv("VITE_T3CODE_RELAY_URL", origin);
  vi.stubEnv("VITE_CONNECT_HOSTED_APP_URL", "https://app.example.test");
}
function makeSubscription(key = pushKey, endpoint = "https://push.example.test/old-device") {
  return {
    endpoint,
    options: { applicationServerKey: Uint8Array.from(atob(key), (c) => c.charCodeAt(0)).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "test-public", auth: "test-auth" } }),
    unsubscribe,
  } as unknown as PushSubscription;
}
function enable() {
  renderer.root
    .findByProps({ "aria-label": "Enable notifications on this device" })
    .props.onCheckedChange(true);
}
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => node.props.children === label)!;
}
async function mount() {
  await act(async () => {
    renderer = create(<PwaNotificationSettings />);
  });
}
beforeEach(() => {
  values.clear();
  operations.length = 0;
  existing = null;
  fixture.settings = {
    agentNotifications: {
      enabled: false,
      notifyOnCompletion: true,
      notifyOnPlanReady: true,
      notifyOnInput: true,
      notifyOnFailure: true,
      showProjectAndThreadNames: true,
    },
  };
  fixture.update
    .mockReset()
    .mockImplementation((patch: { agentNotifications: AgentNotificationPreferences }) => {
      fixture.settings = { ...fixture.settings, ...patch };
      for (const listener of fixture.listeners) listener();
    });
  fixture.toast.mockReset();
  unsubscribe.mockReset().mockImplementation(async () => {
    operations.push("unsubscribe");
    existing = null;
    return true;
  });
  subscribe.mockReset().mockImplementation(() => {
    operations.push("subscribe");
    existing ??= makeSubscription(pushKey, "https://push.example.test/new-device");
    return Promise.resolve(existing);
  });
  getSubscription.mockReset().mockImplementation(async () => {
    operations.push("getSubscription");
    return existing;
  });
  preview.mockReset().mockResolvedValue(undefined);
  const registration = { pushManager: { subscribe, getSubscription }, showNotification: preview };
  fixture.worker.mockReset().mockResolvedValue({ type: "ready", registration });
  fixture.activeWorker.mockReset().mockReturnValue(registration);
  browser = Object.assign(new EventTarget(), {
    isSecureContext: true,
    Notification: {},
    matchMedia: () => ({ matches: true }),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", {
    serviceWorker: {
      getRegistration: async () => {
        operations.push("getRegistration");
        return registration;
      },
    },
  });
  vi.stubGlobal("Notification", { permission: "granted" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    operations.push("fetch");
    return {
      ok: true,
      status: 200,
      json: async () =>
        init?.method === "PUT" ? { subscriptionId: "remote-1" } : { applicationServerKey: pushKey },
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  owned();
});
afterEach(() => {
  vi.useRealTimers();
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("cloudless old enabled state has zero HTTP, preserves credentials, permits preview and local disable", async () => {
  vi.stubEnv("VITE_CONNECT_MODE", "cloudless");
  fixture.settings.agentNotifications.enabled = true;
  existing = makeSubscription();
  values.set("t3code.pwaPushInstallationId", "old-id");
  values.set("t3code.pwaPushInstallationSecret", "old-secret");
  values.set("t3code.webPushSubscriptionId", "old-subscription");
  const before = [...values];
  await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(fixture.worker).toHaveBeenCalled();
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  await act(async () => button("Send preview").props.onClick());
  expect(preview).toHaveBeenCalled();
  await act(async () => button("Disable").props.onClick());
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  for (const [key, value] of before) expect(values.get(key)).toBe(value);
});
it("keeps the first awaited browser operation subscribe on a direct enable tap and enrolls fresh anonymously", async () => {
  values.set("t3code.pwaPushInstallationId", "unbound-id");
  values.set("t3code.pwaPushInstallationSecret", "unbound-secret");
  await mount();
  expect(values.size).toBe(2);
  operations.length = 0;
  await act(async () => {
    enable();
    expect(operations[0]).toBe("subscribe");
  });
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  expect(getPwaPushSubscriptionId()).toBe("remote-1");
  const request = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(request[1]!.body as string).installation.installationId).not.toBe("unbound-id");
  expect(values.get("t3code.pwaPushInstallationSecret")).toBe("unbound-secret");
  expect(unsubscribe).not.toHaveBeenCalled();
});
it.each(["origin", "key", "unbound"])(
  "requires separate reset and enable taps for a %s change without auto forwarding old endpoints",
  async (change) => {
    existing = makeSubscription();
    if (change !== "unbound") {
      await registerPwaPushSubscription({
        environmentId: "environment-1",
        subscription: existing,
        applicationServerKey: pushKey,
        preferences: fixture.settings.agentNotifications,
        explicitEnable: true,
      });
    } else values.set("t3code.webPushSubscriptionId", "old-unbound-id");
    fixture.settings.agentNotifications.enabled = true;
    const before = [...values];
    if (change === "origin") owned("https://other.example.test");
    if (change === "key") existing = makeSubscription("BAUG");
    fetchMock.mockClear();
    await mount();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect([...values]).toEqual(before);
    await act(async () => enable());
    expect(subscribe).not.toHaveBeenCalled();
    await act(async () => button("Reset browser push").props.onClick());
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(fixture.settings.agentNotifications.enabled).toBe(false);
    operations.length = 0;
    await act(async () => {
      enable();
      expect(operations[0]).toBe("subscribe");
    });
    expect(fixture.settings.agentNotifications.enabled).toBe(true);
    const requests = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(requests.length).toBeGreaterThan(0);
    for (const [url, init] of requests) {
      expect(new URL(url).origin).toBe(
        change === "origin" ? "https://other.example.test" : "https://relay.example.test",
      );
      expect(JSON.parse(init!.body as string).endpoint).toBe(
        "https://push.example.test/new-device",
      );
    }
    if (change === "origin" || change === "unbound")
      for (const [key, value] of before) expect(values.get(key)).toBe(value);
  },
);
it("automatic preference sync stays within a trusted realm and preserves saved state while offline", async () => {
  existing = makeSubscription();
  await registerPwaPushSubscription({
    environmentId: "environment-1",
    subscription: existing,
    applicationServerKey: pushKey,
    preferences: fixture.settings.agentNotifications,
    explicitEnable: true,
  });
  fixture.settings.agentNotifications.enabled = true;
  const before = [...values];
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method) throw new Error("offline");
    return { ok: true, status: 200, json: async () => ({ applicationServerKey: pushKey }) };
  });
  await mount();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  for (const [key, value] of before) expect(values.get(key)).toBe(value);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(subscribe).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
});
it("a disabled anonymous service shows unavailable, stops event retries, and never asks for sign-in", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 503 });
  await mount();
  await act(async () => {
    browser.dispatchEvent(new Event("online"));
    browser.dispatchEvent(new Event("focus"));
    enable();
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(subscribe).not.toHaveBeenCalled();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(JSON.stringify(fixture.toast.mock.calls)).toContain("does not offer anonymous PWA push");
  expect(JSON.stringify(fixture.toast.mock.calls)).not.toMatch(/sign.in/i);
});
it("cloudless local preview can request permission without enrolling or contacting a relay", async () => {
  vi.stubEnv("VITE_CONNECT_MODE", "cloudless");
  const requestPermission = vi.fn().mockImplementation(() => {
    Object.defineProperty(Notification, "permission", { value: "granted" });
    return Promise.resolve("granted");
  });
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  await mount();
  await act(async () => {
    button("Send preview").props.onClick();
    expect(requestPermission).toHaveBeenCalledOnce();
  });
  expect(preview).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
  expect(values.size).toBe(0);
});

async function seedBoundSubscription() {
  existing = makeSubscription();
  await registerPwaPushSubscription({
    environmentId: "environment-1",
    subscription: existing,
    applicationServerKey: pushKey,
    preferences: fixture.settings.agentNotifications,
    explicitEnable: true,
  });
  fixture.settings.agentNotifications.enabled = true;
  await mount();
  fetchMock.mockClear();
}
it.each(["rejection", "false"])(
  "keeps local cleanup reachable after unsubscribe %s and safely removes the current remote registration",
  async (failure) => {
    await seedBoundSubscription();
    if (failure === "rejection")
      unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
    else unsubscribe.mockResolvedValueOnce(false);
    await act(async () => button("Disable").props.onClick());
    expect(existing).not.toBeNull();
    expect(fixture.settings.agentNotifications.enabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(getPwaPushSubscriptionId()).toBeNull();
    expect(button("Disable") ?? button("Reset browser push")).toBeDefined();
    expect(JSON.stringify(fixture.toast.mock.calls)).toContain("cleanup is incomplete");
    await act(async () => (button("Disable") ?? button("Reset browser push")).props.onClick());
    expect(existing).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).not.toHaveBeenCalled();
  },
);
it("keeps a cleanup retry after reload when disabled preferences still have a bound browser endpoint", async () => {
  await seedBoundSubscription();
  unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method) throw new Error("remote offline");
    return { ok: true, status: 200, json: async () => ({ applicationServerKey: pushKey }) };
  });
  await act(async () => button("Disable").props.onClick());
  expect(existing).not.toBeNull();
  expect(getPwaPushSubscriptionId()).toBe("remote-1");
  act(() => renderer.unmount());
  await mount();
  expect(button("Disable") ?? button("Reset browser push")).toBeDefined();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  const callsBeforeEnable = fetchMock.mock.calls.length;
  await act(async () => enable());
  expect(fetchMock.mock.calls).toHaveLength(callsBeforeEnable);
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => button("Disable").props.onClick());
  expect(existing).toBeNull();
});
it.each(["owned-foreign", "cloudless"])(
  "local unsubscribe failure and retry in %s never send old credentials remotely",
  async (mode) => {
    await seedBoundSubscription();
    const before = [...values];
    act(() => renderer.unmount());
    if (mode === "cloudless") vi.stubEnv("VITE_CONNECT_MODE", "cloudless");
    else owned("https://other.example.test");
    fetchMock.mockClear();
    await mount();
    unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
    await act(async () => (button("Disable") ?? button("Reset browser push")).props.onClick());
    expect(existing).not.toBeNull();
    expect(fixture.settings.agentNotifications.enabled).toBe(false);
    act(() => renderer.unmount());
    await mount();
    expect(button("Disable") ?? button("Reset browser push")).toBeDefined();
    await act(async () => (button("Disable") ?? button("Reset browser push")).props.onClick());
    expect(existing).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    if (mode === "cloudless") expect(fetchMock).not.toHaveBeenCalled();
    for (const [key, value] of before) expect(values.get(key)).toBe(value);
  },
);
it.each(["malformed", "foreign"])(
  "Disable preserves the %s current record until a separate Reset and Enable",
  async (recordType) => {
    const key = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
    const raw =
      recordType === "malformed"
        ? '{invalid-json\n"private": "private-old-secret"'
        : JSON.stringify({
            version: 1,
            relayOrigin: "https://other.example.test",
            installation: { installationId: "foreign-id", installationSecret: "foreign-secret" },
            subscription: null,
          });
    values.set(key, raw);
    values.set("t3code.pwaPushInstallationSecret", "unbound-secret");
    existing = makeSubscription();
    await mount();
    expect(values.get(key)).toBe(raw);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    await act(async () => button("Disable").props.onClick());
    expect(existing).toBeNull();
    expect(values.get(key)).toBe(raw);
    expect([...values.keys()].some((target) => target.startsWith(`${key}:quarantine:`))).toBe(
      false,
    );
    expect(button("Reset browser push").props.disabled).toBe(false);
    await act(async () => enable());
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    await act(async () => button("Reset browser push").props.onClick());
    expect(existing).toBeNull();
    expect(values.has(key)).toBe(false);
    expect(
      [...values.entries()].some(
        ([archiveKey, value]) => archiveKey.startsWith(`${key}:quarantine:`) && value === raw,
      ),
    ).toBe(true);
    expect(subscribe).not.toHaveBeenCalled();
    operations.length = 0;
    await act(async () => {
      enable();
      expect(operations[0]).toBe("subscribe");
    });
    expect(fixture.settings.agentNotifications.enabled).toBe(true);
    expect(getPwaPushSubscriptionId()).toBe("remote-1");
    expect([...values.values()]).toContain(raw);
    expect(values.get("t3code.pwaPushInstallationSecret")).toBe("unbound-secret");
    for (const [, init] of fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")) {
      expect(JSON.parse(init!.body as string).installation.installationId).not.toBe("foreign-id");
      expect(JSON.parse(init!.body as string).installation.installationSecret).not.toBe(
        "foreign-secret",
      );
    }
  },
);
it("storage preservation failure keeps the occupied record and an explicit reset retry after reload", async () => {
  const key = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
  const raw = "private-invalid-record";
  values.set(key, raw);
  existing = makeSubscription();
  const setItem = window.localStorage.setItem.bind(window.localStorage);
  const storageFailure = vi
    .spyOn(window.localStorage, "setItem")
    .mockImplementation((target, value) => {
      if (target.startsWith(`${key}:quarantine:`)) throw new Error(raw);
      setItem(target, value);
    });
  await mount();
  await act(async () => button("Reset browser push").props.onClick());
  expect(existing).toBeNull();
  expect(values.get(key)).toBe(raw);
  expect(
    [...values.entries()].filter(([target]) => target.startsWith(`${key}:quarantine:`)),
  ).toHaveLength(0);
  expect(JSON.stringify(fixture.toast.mock.calls)).not.toContain(raw);
  act(() => renderer.unmount());
  await mount();
  expect(button("Reset browser push")).toBeDefined();
  await act(async () => enable());
  expect(subscribe).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  storageFailure.mockRestore();
  await act(async () => button("Reset browser push").props.onClick());
  await act(async () => enable());
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  expect([...values.values()]).toContain(raw);
});
it("full local storage cannot hide a failed browser cleanup retry or erase old authority", async () => {
  await seedBoundSubscription();
  const before = [...values];
  const storageFailure = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("storage full");
  });
  unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
  await act(async () => button("Disable").props.onClick());
  expect(existing).not.toBeNull();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(button("Disable") ?? button("Reset browser push")).toBeDefined();
  expect([...values]).toEqual(before);
  storageFailure.mockRestore();
  await act(async () => button("Disable").props.onClick());
  expect(existing).toBeNull();
});
it("Disable preserves authority and uncertainty when remote failure precedes local completion", async () => {
  await seedBoundSubscription();
  const key = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
  const raw = values.get(key)!;
  const originalInstallation = JSON.parse(raw).installation;
  let finishLocal: () => void = () => {};
  unsubscribe.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finishLocal = () => {
          existing = null;
          resolve(true);
        };
      }),
  );
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("offline");
    return {
      ok: true,
      status: 200,
      json: async () =>
        init?.method === "PUT" ? { subscriptionId: "remote-1" } : { applicationServerKey: pushKey },
    };
  });
  await act(async () => button("Disable").props.onClick());
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(existing).not.toBeNull();
  await act(async () => finishLocal());
  expect(existing).toBeNull();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(values.get(key)).toBe(raw);
  expect([...values.keys()].some((target) => target.startsWith(`${key}:quarantine:`))).toBe(false);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(button("Reset browser push").props.disabled).toBe(false);
  await act(async () => enable());
  expect(subscribe).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  await act(async () => button("Reset browser push").props.onClick());
  expect(values.get(`${key}:quarantine:0`)).toBe(raw);
  expect(values.has(key)).toBe(false);
  expect(getPwaPushRemovalState()).toBe("none");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  operations.length = 0;
  await act(async () => {
    enable();
    expect(operations[0]).toBe("subscribe");
  });
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  expect(JSON.parse(values.get(key)!).installation).not.toEqual(originalInstallation);
  expect(values.get(`${key}:quarantine:0`)).toBe(raw);
});
it.each(["reject", "false"])(
  "local cleanup retries stay available with %s unsubscribe and a hung deduplicated remote removal",
  async (failure) => {
    await seedBoundSubscription();
    let resolveRemove: (value: object) => void = () => {};
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise((resolve) => {
          resolveRemove = resolve;
        });
      return {
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "PUT"
            ? { subscriptionId: "remote-1" }
            : { applicationServerKey: pushKey },
      };
    });
    if (failure === "reject") unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
    else unsubscribe.mockResolvedValueOnce(false);
    await act(async () => button("Disable").props.onClick());
    expect(existing).not.toBeNull();
    expect(fixture.settings.agentNotifications.enabled).toBe(false);
    expect(button("Reset browser push").props.disabled).toBe(false);
    expect(button("Disable").props.disabled).toBe(false);
    await act(async () => button("Reset browser push").props.onClick());
    expect(existing).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const beforeEnable = [...values];
    await act(async () => enable());
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    expect([...values]).toEqual(beforeEnable);
    expect(JSON.stringify(fixture.toast.mock.calls)).toContain("Remote cleanup is pending");
    await act(async () =>
      resolveRemove({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    );
    expect(getPwaPushSubscriptionId()).toBeNull();
    operations.length = 0;
    await act(async () => {
      enable();
      expect(operations[0]).toBe("subscribe");
    });
    expect(fixture.settings.agentNotifications.enabled).toBe(true);
    expect(getPwaPushSubscriptionId()).toBe("remote-1");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  },
);
it("late removal completion cannot mutate unmounted settings or hide a remounted local retry", async () => {
  await seedBoundSubscription();
  let resolveRemove: (value: object) => void = () => {};
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return new Promise((resolve) => {
        resolveRemove = resolve;
      });
    return { ok: true, status: 200, json: async () => ({ applicationServerKey: pushKey }) };
  });
  unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
  await act(async () => button("Disable").props.onClick());
  act(() => renderer.unmount());
  const updates = fixture.update.mock.calls.length;
  const toasts = fixture.toast.mock.calls.length;
  await act(async () => resolveRemove({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  expect(fixture.update).toHaveBeenCalledTimes(updates);
  expect(fixture.toast).toHaveBeenCalledTimes(toasts);
  expect(existing).not.toBeNull();
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  await mount();
  expect(button("Reset browser push").props.disabled).toBe(false);
  await act(async () => button("Reset browser push").props.onClick());
  expect(existing).toBeNull();
});
it("cancelled auto-sync preserves admission across Disable and remount, and Reset isolates a late server PUT", async () => {
  existing = makeSubscription();
  await registerPwaPushSubscription({
    environmentId: "environment-1",
    subscription: existing,
    applicationServerKey: pushKey,
    preferences: fixture.settings.agentNotifications,
    explicitEnable: true,
  });
  fixture.settings.agentNotifications.enabled = true;
  const slot = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
  const raw = values.get(slot)!;
  const original = JSON.parse(raw).installation;
  // Production upserts conflict on installationId. Model SQL's write lifetime
  // independently of fetch cancellation, which only ends the client request.
  const rows = new Map([[original.installationId, existing.endpoint]]);
  let oldServerPut: (() => void) | undefined;
  let aborted = false;
  fetchMock.mockClear().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const payload = JSON.parse(String(init.body));
      if (!oldServerPut) {
        oldServerPut = () => rows.set(payload.installation.installationId, payload.endpoint);
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("AbortError"));
            },
            { once: true },
          );
        });
      }
      rows.set(payload.installation.installationId, payload.endpoint);
      return { ok: true, status: 200, json: async () => ({ subscriptionId: "remote-1" }) };
    }
    if (init?.method === "POST") {
      rows.delete(JSON.parse(String(init.body)).installation.installationId);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ applicationServerKey: pushKey }) };
  });
  await mount();
  expect(oldServerPut).toBeTypeOf("function");
  await act(async () => button("Disable").props.onClick());
  expect(aborted).toBe(true);
  expect(rows.size).toBe(0);
  expect(existing).toBeNull();
  expect(values.get(slot)).toBe(raw);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  await act(async () => enable());
  expect(subscribe).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  act(() => renderer.unmount());
  await mount();
  expect(button("Reset browser push").props.disabled).toBe(false);
  const setItem = window.localStorage.setItem.bind(window.localStorage);
  const failedArchive = vi
    .spyOn(window.localStorage, "setItem")
    .mockImplementation((key, value) => {
      if (key.startsWith(`${slot}:quarantine:`)) throw new Error("storage full");
      setItem(key, value);
    });
  await act(async () => button("Reset browser push").props.onClick());
  expect(values.get(slot)).toBe(raw);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  failedArchive.mockRestore();
  await act(async () => button("Reset browser push").props.onClick());
  expect(values.get(`${slot}:quarantine:0`)).toBe(raw);
  expect(getPwaPushRemovalState()).toBe("none");
  operations.length = 0;
  await act(async () => {
    enable();
    expect(operations[0]).toBe("subscribe");
  });
  const replacement = values.get(slot)!;
  const installation = JSON.parse(replacement).installation;
  expect(installation.installationId).not.toBe(original.installationId);
  expect(installation.installationSecret).not.toBe(original.installationSecret);
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  expect(rows.get(installation.installationId)).toBe(existing!.endpoint);
  oldServerPut!();
  expect(rows.get(installation.installationId)).toBe(existing!.endpoint);
  expect(values.get(slot)).toBe(replacement);
});
it("a hung Enable PUT becomes uncertain without holding local Reset controls busy", async () => {
  await mount();
  let resolvePut: (value: object) => void = () => {};
  fetchMock.mockClear().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT")
      return new Promise((resolve) => {
        resolvePut = resolve;
      });
    return { ok: true, status: 200, json: async () => ({ applicationServerKey: pushKey }) };
  });
  vi.useFakeTimers();
  await act(async () => enable());
  const slot = "t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test";
  const raw = values.get(slot)!;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(getPwaPushRemovalState()).toBe("uncertain");
  expect(button("Reset browser push").props.disabled).toBe(false);
  await act(async () => button("Disable").props.onClick());
  expect(existing).toBeNull();
  expect(values.get(slot)).toBe(raw);
  await act(async () => button("Reset browser push").props.onClick());
  expect(values.get(`${slot}:quarantine:0`)).toBe(raw);
  const afterReset = [...values];
  await act(async () =>
    resolvePut({ ok: true, status: 200, json: async () => ({ subscriptionId: "late" }) }),
  );
  expect([...values]).toEqual(afterReset);
  expect(getPwaPushSubscriptionId()).toBeNull();
});
it("timed out remote cleanup releases local controls and explicit owned Reset safely prepares fresh enrollment", async () => {
  await seedBoundSubscription();
  const originalRecord = values.get("t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test")!;
  let resolveLateRemoval: (value: object) => void = () => {};
  vi.useFakeTimers();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return new Promise((resolve) => {
        resolveLateRemoval = resolve;
      });
    return {
      ok: true,
      status: 200,
      json: async () =>
        init?.method === "PUT" ? { subscriptionId: "remote-1" } : { applicationServerKey: pushKey },
    };
  });
  unsubscribe.mockRejectedValueOnce(new Error("browser unavailable"));
  await act(async () => button("Disable").props.onClick());
  expect(button("Reset browser push").props.disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(button("Reset browser push").props.disabled).toBe(false);
  await act(async () => enable());
  expect(fixture.settings.agentNotifications.enabled).toBe(false);
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => button("Reset browser push").props.onClick());
  expect(existing).toBeNull();
  expect([...values.values()]).toContain(originalRecord);
  operations.length = 0;
  await act(async () => {
    enable();
    expect(operations[0]).toBe("subscribe");
  });
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  const replacement = values.get("t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test");
  await act(async () =>
    resolveLateRemoval({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  );
  expect(values.get("t3code.pwaPushAuthority.v1:https%3A%2F%2Frelay.example.test")).toBe(
    replacement,
  );
  expect(fixture.settings.agentNotifications.enabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  vi.useRealTimers();
});
