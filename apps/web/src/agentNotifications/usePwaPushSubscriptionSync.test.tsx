import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { usePwaPushSubscriptionSync } from "./usePwaPushSubscriptionSync";

const { getSubscription, canSync } = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  canSync: vi.fn(),
}));
vi.mock("./browserNotifications", () => ({
  getExistingBrowserPushSubscription: getSubscription,
}));

vi.mock("./pwaPushRelay", () => ({ canSyncPwaPushSubscription: canSync }));

let renderer: ReactTestRenderer;
const onSubscription = vi.fn();
const onMissingSubscription = vi.fn();
const onBindingMismatch = vi.fn();

function Probe({
  enabled = true,
  vapidKey = "AQID",
}: {
  enabled?: boolean;
  vapidKey?: string | null;
}) {
  usePwaPushSubscriptionSync({
    enabled,
    applicationServerKey: vapidKey,
    onSubscription,
    onMissingSubscription,
    onBindingMismatch,
  });
  return null;
}

beforeEach(() => {
  getSubscription.mockReset().mockResolvedValue(null);
  onSubscription.mockReset().mockResolvedValue(undefined);
  onMissingSubscription.mockReset();
  onBindingMismatch.mockReset();
  canSync.mockReset().mockReturnValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("repairs enabled settings when the browser subscription has disappeared", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onMissingSubscription).toHaveBeenCalledOnce();
  expect(onSubscription).not.toHaveBeenCalled();
});

it("synchronizes an existing subscription without disabling it", async () => {
  const subscription = { endpoint: "https://push.example/device" };
  getSubscription.mockResolvedValue(subscription);
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onSubscription).toHaveBeenCalledWith(subscription, expect.any(AbortSignal));
  expect(onMissingSubscription).not.toHaveBeenCalled();
});

it("keeps enabled settings when checking the browser subscription fails", async () => {
  getSubscription.mockRejectedValue(new Error("temporarily unavailable"));
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onMissingSubscription).not.toHaveBeenCalled();
  expect(onSubscription).not.toHaveBeenCalled();
});

it("does not synchronize a subscription while notifications are disabled", async () => {
  await act(async () => {
    renderer = create(<Probe enabled={false} />);
  });
  expect(getSubscription).not.toHaveBeenCalled();
});

it.each(["unmount", "disable"])("ignores a stale subscription check after %s", async (action) => {
  let resolve: (value: null) => void = () => {};
  getSubscription.mockReturnValue(
    new Promise<null>((done) => {
      resolve = done;
    }),
  );
  await act(async () => {
    renderer = create(<Probe />);
  });
  act(() => {
    if (action === "unmount") renderer.unmount();
    else renderer.update(<Probe enabled={false} />);
  });
  await act(async () => {
    resolve(null);
  });
  expect(onMissingSubscription).not.toHaveBeenCalled();
  expect(onSubscription).not.toHaveBeenCalled();
});

it("requires preload key authority before an automatic browser check", async () => {
  await act(async () => {
    renderer = create(<Probe vapidKey={null} />);
  });
  expect(getSubscription).not.toHaveBeenCalled();
});
it("refuses an unbound or foreign browser subscription without changing enabled intent", async () => {
  canSync.mockReturnValue(false);
  getSubscription.mockResolvedValue({ endpoint: "https://push.example/foreign" });
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(onSubscription).not.toHaveBeenCalled();
  expect(onMissingSubscription).not.toHaveBeenCalled();
  expect(onBindingMismatch).toHaveBeenCalledOnce();
});
it("aborts in-flight synchronization when disabled", async () => {
  getSubscription.mockResolvedValue({ endpoint: "https://push.example/device" });
  await act(async () => {
    renderer = create(<Probe />);
  });
  const signal = onSubscription.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  await act(async () => renderer.update(<Probe enabled={false} />));
  expect(signal.aborted).toBe(true);
});
