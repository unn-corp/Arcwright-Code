import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { act, useContext } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  reconcile: vi.fn(() => () => {}),
}));

vi.mock("./composerDraftStore", async (original) => ({
  ...(await original<typeof import("./composerDraftStore")>()),
  subscribeComposerDraftModelReconciliation: state.reconcile,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  RouterProvider: () => <RegistryProbe name="router" />,
}));
vi.mock("./agentNotifications/DesktopAgentNotificationCoordinator", () => ({
  DesktopAgentNotificationCoordinator: () => <RegistryProbe name="notifications" />,
}));
vi.mock("./android/AndroidBrowserHosts", () => ({
  AndroidBrowserHosts: () => <RegistryProbe name="android" />,
}));
vi.mock("./browser/ElectronBrowserHost", () => ({
  ElectronBrowserHost: () => <RegistryProbe name="electron" />,
}));
vi.mock("./browser/BrowserProfileReporter", () => ({
  BrowserProfileReporter: () => <RegistryProbe name="profiles" />,
}));
vi.mock("./components/QuitHoldOverlay", () => ({
  QuitHoldOverlay: () => <RegistryProbe name="quit" />,
}));

import { appAtomRegistry } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";

const sharedValue = Atom.make("default registry");
function RegistryProbe({ name }: { name: string }) {
  const registry = useContext(RegistryContext);
  const value = useAtomValue(sharedValue);
  return (
    <span data-host={name} data-app-registry={registry === appAtomRegistry}>
      {value}
    </span>
  );
}

let root: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  state.reconcile.mockClear();
});

describe("AppRoot", () => {
  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    appAtomRegistry.set(sharedValue, "application state");
    const unsubscribe = vi.fn();
    state.reconcile.mockReturnValueOnce(unsubscribe);
    await act(async () => {
      root = create(<AppRoot router={{} as AppRouter} />);
    });

    const hosts = root!.root.findAllByType("span");
    expect(hosts.map((host) => host.props["data-host"])).toEqual([
      "router",
      "notifications",
      "android",
      "electron",
      "profiles",
      "quit",
    ]);
    for (const host of hosts) {
      expect(host.props["data-app-registry"]).toBe(true);
      expect(host.children).toEqual(["application state"]);
    }
    expect(state.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ registry: appAtomRegistry }),
    );

    await act(async () => appAtomRegistry.set(sharedValue, "updated state"));
    for (const host of hosts) expect(host.children).toEqual(["updated state"]);
    await act(async () => root!.unmount());
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
