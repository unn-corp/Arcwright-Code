import { afterEach, assert, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";
import * as IpcChannels from "./ipc/channels.ts";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    sendSync: mocks.sendSync,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
  webFrame: {},
  webUtils: {},
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));

const loadBridge = async (): Promise<DesktopBridge> => {
  await import("./preload.ts");
  const call = mocks.expose.mock.calls.find(([name]) => name === "desktopBridge");
  assert.isDefined(call);
  return call![1] as DesktopBridge;
};

describe("desktop preload local environment controls", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.sendSync.mockImplementation(() => undefined);
    mocks.invoke.mockResolvedValue(undefined);
    vi.stubGlobal("window", { addEventListener: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("removes the exact topology listener and treats invalid sync responses as failed reads", async () => {
    const bridge = await loadBridge();
    const listener = vi.fn();
    const cleanup = bridge.onLocalEnvironmentBootstrapsChanged!(listener);
    const [channel, handler] = mocks.on.mock.calls[0]!;
    expect(channel).toBe(IpcChannels.LOCAL_ENVIRONMENT_TOPOLOGY_CHANGED_CHANNEL);
    handler();
    expect(listener).toHaveBeenCalledOnce();
    cleanup();
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, handler);
    expect(() => bridge.getLocalEnvironmentBootstraps()).toThrow(
      "Could not read desktop environment topology.",
    );
    mocks.sendSync.mockReturnValue([]);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual([]);
  });

  it("exposes the persisted local mode before the renderer bootstraps its primary session", async () => {
    mocks.sendSync.mockImplementation((channel) =>
      channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL ? false : undefined,
    );
    const bridge = await loadBridge();
    assert.isFunction(bridge.getLocalEnvironmentEnabled);
    assert.isFalse(bridge.getLocalEnvironmentEnabled!());
    assert.isFunction(bridge.setLocalEnvironmentEnabled);
    assert.equal(mocks.invoke.mock.calls.length, 0);
  });

  it("does not turn an unreadable native local mode into an enabled primary environment", async () => {
    mocks.sendSync.mockImplementation((channel) => {
      if (channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL)
        throw new Error("Native local mode is unavailable");
      return undefined;
    });
    const bridge = await loadBridge();
    expect(() => bridge.getLocalEnvironmentEnabled!()).toThrow("Native local mode is unavailable");
  });
});
