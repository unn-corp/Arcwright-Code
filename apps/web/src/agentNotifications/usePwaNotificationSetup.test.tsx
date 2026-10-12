import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePwaNotificationSetup } from "./usePwaNotificationSetup";

const { getConfig, registerWorker, getSubscription, relayProfile, canSync } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  registerWorker: vi.fn(),
  getSubscription: vi.fn(),
  relayProfile: vi.fn(),
  canSync: vi.fn(),
}));
vi.mock("./pwaPushRelay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pwaPushRelay")>()),
  getPwaPushConfig: getConfig,
  getPwaPushRelayProfile: relayProfile,
  canSyncPwaPushSubscription: canSync,
}));
vi.mock("./browserNotifications", () => ({ getExistingBrowserPushSubscription: getSubscription }));
vi.mock("../pwa", () => ({ registerPwaServiceWorker: registerWorker }));

let renderer: ReactTestRenderer;
let setup: ReturnType<typeof usePwaNotificationSetup>;
let page: EventTarget & { visibilityState: string };
let browser: EventTarget;

function Probe() {
  const value = usePwaNotificationSetup();
  useLayoutEffect(() => {
    setup = value;
  });
  return null;
}

beforeEach(() => {
  getSubscription.mockReset().mockResolvedValue(null);
  relayProfile.mockReset().mockReturnValue({
    type: "available",
    mode: "owned",
    relayOrigin: "https://relay.example.test",
  });
  canSync.mockReset().mockReturnValue(true);
  getConfig.mockReset().mockResolvedValue("push-key");
  registerWorker.mockReset().mockResolvedValue({ type: "ready" });
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  browser = new EventTarget();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", browser);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each(["online", "focus", "visibilitychange"])(
  "recovers failed push configuration on %s without reloading",
  async (event) => {
    getConfig.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(setup.vapidPublicKey).toBeNull();
    expect(setup.isConfigLoading).toBe(false);
    await act(async () => {
      (event === "visibilitychange" ? page : browser).dispatchEvent(new Event(event));
    });
    expect(setup.vapidPublicKey).toBe("push-key");
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(registerWorker).toHaveBeenCalledTimes(2);
    await act(async () => browser.dispatchEvent(new Event("focus")));
    expect(getConfig).toHaveBeenCalledTimes(2);
  },
);

it("allows an enable interaction to retry a failed preload", async () => {
  getConfig.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => setup.retry());
  expect(setup.vapidPublicKey).toBe("push-key");
});

it("deduplicates recovery events during a pending configuration request", async () => {
  let resolveConfig: (key: string) => void = () => {};
  getConfig.mockReturnValue(new Promise<string>((resolve) => (resolveConfig = resolve)));
  await act(async () => {
    renderer = create(<Probe />);
    browser.dispatchEvent(new Event("focus"));
    browser.dispatchEvent(new Event("online"));
  });
  expect(getConfig).toHaveBeenCalledOnce();
  expect(setup.isConfigLoading).toBe(true);
  await act(async () => resolveConfig("push-key"));
  expect(setup.vapidPublicKey).toBe("push-key");
  expect(setup.isConfigLoading).toBe(false);
});

it("stops retrying after unmount", async () => {
  getConfig.mockRejectedValue(new Error("offline"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  act(() => renderer.unmount());
  browser.dispatchEvent(new Event("online"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(getConfig).toHaveBeenCalledOnce();
});

it("prepares the local worker but never preloads remote config for a blocked profile", async () => {
  relayProfile.mockReturnValue({ type: "blocked", reason: "cloudless" });
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(setup.setupState).toBe("unavailable");
  expect(setup.isConfigLoading).toBe(false);
  await act(async () => {
    browser.dispatchEvent(new Event("online"));
    setup.retry();
  });
  expect(getConfig).not.toHaveBeenCalled();
  expect(getSubscription).not.toHaveBeenCalled();
  expect(registerWorker).toHaveBeenCalled();
});
it("requires a separate reset for an incompatible preexisting subscription", async () => {
  getSubscription.mockResolvedValue({ endpoint: "https://push.example/old" });
  canSync.mockReturnValue(false);
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(setup.vapidPublicKey).toBe("push-key");
  expect(setup.setupState).toBe("reset-required");
});
it("ignores an old configuration response after retry", async () => {
  let oldResolve: (key: string) => void = () => {};
  getConfig.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      oldResolve = resolve;
    }),
  );
  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => setup.retry());
  await act(async () => oldResolve("old-key"));
  expect(setup.vapidPublicKey).toBe("push-key");
});
