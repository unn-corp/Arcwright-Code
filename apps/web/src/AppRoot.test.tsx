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
import { DESKTOP_PASTE_AS_TEXT_EVENT } from "./lib/desktopPasteAsText";

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
  it("arms paste-as-text before native paste and removes the menu listener on unmount", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const menuActionListeners = new Set<(action: string) => void>();
    const unsubscribe = vi.fn();
    const observed: string[] = [];
    const pasteAsText = vi.fn(() => observed.push("native-paste"));
    const appWindow = Object.assign(new EventTarget(), {
      desktopBridge: {
        onMenuAction: (listener: (action: string) => void) => {
          menuActionListeners.add(listener);
          return () => {
            menuActionListeners.delete(listener);
            unsubscribe();
          };
        },
        pasteAsText,
      },
    });
    appWindow.addEventListener(DESKTOP_PASTE_AS_TEXT_EVENT, () => observed.push("armed"));
    vi.stubGlobal("window", appWindow);

    await act(async () => {
      root = create(<AppRoot router={{} as AppRouter} />);
    });

    const sendMenuAction = (action: string) => {
      for (const listener of menuActionListeners) listener(action);
    };
    await act(async () => sendMenuAction("open-settings"));
    expect(observed).toEqual([]);
    expect(pasteAsText).not.toHaveBeenCalled();

    await act(async () => sendMenuAction("paste-as-text"));
    expect(observed).toEqual(["armed", "native-paste"]);
    expect(pasteAsText).toHaveBeenCalledOnce();

    await act(async () => root!.unmount());
    root = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
    await act(async () => sendMenuAction("paste-as-text"));
    expect(observed).toEqual(["armed", "native-paste"]);
  });

  it("shares the application atom registry with routed UI and renderer-wide desktop hosts", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", new EventTarget());
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
