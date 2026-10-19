import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentId,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import type { RelayManagedEndpointProviderKind } from "@t3tools/contracts/relay";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  configured: true,
  signedIn: true,
  snapshot: null as EnvironmentCloudLinkStateResult | null,
  renderedSnapshot: null as EnvironmentCloudLinkStateResult | null,
  relayProviderKind: null as RelayManagedEndpointProviderKind | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    environments: new Map(
      testState.relayProviderKind === null
        ? []
        : [
            [
              "primary",
              { environment: { endpoint: { providerKind: testState.relayProviderKind } } },
            ],
          ],
    ),
  })) as never,
}));
vi.mock("../auth/managedAuthContext", () => ({
  useManagedAuth: () => ({ getRelayToken: testState.getToken, isSignedIn: testState.signedIn }),
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } as never };
});
vi.mock(import("../state/relay"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    relayEnvironmentDiscovery: {
      ...actual.relayEnvironmentDiscovery,
      refresh: testState.refreshDiscovery,
    } as never,
  };
});
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: (_environmentId, scope) => testState.scopes.has(scope),
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("./linkEnvironmentAtoms"), async (original) => ({
  ...(await original()),
  linkPrimaryEnvironment: testState.link as never,
  unlinkPrimaryEnvironment: testState.unlink as never,
  updatePrimaryEnvironmentPreferences: testState.preferences as never,
}));
vi.mock(import("./primaryCloudLinkState"), async (original) => ({
  ...(await original()),
  readCachedPrimaryCloudLinkState: () => testState.snapshot,
  usePrimaryCloudLinkState: (() => ({
    target,
    data: testState.renderedSnapshot,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  })) as never,
}));
// The Clerk JWT template is build-time config the test environment does not set.
vi.mock(import("./publicConfig"), async (original) => ({
  ...(await original()),
  resolveRelayClerkTokenOptions: () => ({}) as never,
  hasCloudPublicConfig: () => testState.configured,
}));

import { LocalConnectCleanup } from "../components/settings/LocalConnectCleanup";
import { useCloudLinkController, type CloudLinkDesiredState } from "./useCloudLinkController";

const target = {
  environmentId: EnvironmentId.make("primary"),
  label: "Primary",
  httpBaseUrl: "http://localhost:3773",
  wsBaseUrl: "ws://localhost:3773/ws",
};
const linkedState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-1",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: true,
  publishAgentActivity: false,
};

let root: Root | null = null;
let container: HTMLDivElement;
let controller: ReturnType<typeof useCloudLinkController> | null = null;

function ControllerProbe() {
  const value = useCloudLinkController();
  useLayoutEffect(() => {
    controller = value;
  });
  return (
    <LocalConnectCleanup
      state={value.linkState.data}
      canManage={
        testState.scopes.has(AuthRelayReadScope) && testState.scopes.has(AuthRelayWriteScope)
      }
      pending={value.linkState.isPending}
      unlink={() => value.reconcileCloudState({ managedTunnel: false, publish: false })}
    />
  );
}

async function mountController() {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(<ControllerProbe />));
}

async function reconcile(desired: CloudLinkDesiredState) {
  let succeeded = false;
  await act(async () => {
    if (controller === null) throw new Error("Controller is not mounted.");
    succeeded = await controller.reconcileCloudState(desired);
  });
  return succeeded;
}

function expectNoMutations() {
  expect(testState.link).not.toHaveBeenCalled();
  expect(testState.unlink).not.toHaveBeenCalled();
  expect(testState.preferences).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testState.configured = true;
  testState.signedIn = true;
  testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope]);
  testState.snapshot = linkedState;
  testState.renderedSnapshot = linkedState;
  testState.relayProviderKind = null;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.unlink,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  controller = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCloudLinkController", () => {
  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "does not mutate without %s, even with a cached link snapshot",
    async (scope) => {
      await mountController();
      testState.scopes.delete(scope);

      expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
      expect(testState.getToken).not.toHaveBeenCalled();
      expectNoMutations();
    },
  );

  it("does not interpret unavailable link state as an unlinked environment", async () => {
    testState.snapshot = null;
    await mountController();

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.getToken).not.toHaveBeenCalled();
    expectNoMutations();
  });

  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "rechecks %s after requesting the cloud token",
    async (scope) => {
      await mountController();
      testState.getToken.mockImplementationOnce(async () => {
        testState.scopes.delete(scope);
        return "clerk-token";
      });

      expect(await reconcile({ managedTunnel: false, publish: false })).toBe(false);
      expectNoMutations();
    },
  );

  it("stops if the link-state read fails while requesting the cloud token", async () => {
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = null;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
    expectNoMutations();
  });

  it("uses the latest linked mode to change publishing without replacing the tunnel", async () => {
    testState.snapshot = { ...linkedState, linked: false, managedTunnelActive: false };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = linkedState;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(true);
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledExactlyOnceWith({
      target,
      publishAgentActivity: true,
    });
  });

  it("shows a link the relay holds as publish-only as off and relinks it as managed", async () => {
    testState.relayProviderKind = "manual";
    await mountController();

    expect(controller?.managedTunnelActive).toBe(false);
    expect(controller?.managedTunnelOutOfSync).toBe(true);
    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
      mode: "managed",
    });
  });

  it("shows a revoked link as off and links it again when turned on", async () => {
    testState.snapshot = { ...linkedState, linkRevoked: true };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    expect(controller).toMatchObject({
      linked: false,
      linkRevoked: true,
      managedTunnelActive: false,
      managedTunnelOutOfSync: false,
    });

    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).toHaveBeenCalledExactlyOnceWith({
      target,
      clerkToken: "clerk-token",
      mode: "managed",
    });
  });

  it("keeps a managed link that the relay also holds as managed", async () => {
    testState.relayProviderKind = "cloudflare_tunnel";
    await mountController();

    expect(controller?.managedTunnelActive).toBe(true);
    expect(controller?.managedTunnelOutOfSync).toBe(false);
    expect(await reconcile({ managedTunnel: true, publish: false })).toBe(true);
    expect(testState.link).not.toHaveBeenCalled();
  });

  it("stops the preference write if management permission is lost after linking", async () => {
    await mountController();
    testState.link.mockImplementationOnce(async () => {
      testState.scopes.delete(AuthRelayWriteScope);
      return AsyncResult.success({});
    });

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.link).toHaveBeenCalledOnce();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalledOnce();
  });

  it("still lets an authorized user unlink when the cloud token is unavailable", async () => {
    await mountController();
    testState.getToken.mockRejectedValueOnce(new Error("Cloud sign-in unavailable"));

    expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
  });

  it("unlinks if the link-state read fails while requesting the cloud token", async () => {
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = null;
      throw new Error("Cloud sign-in unavailable");
    });

    expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalledOnce();
  });
  it("requires local unlink before enabling a link saved under another authority", async () => {
    testState.snapshot = {
      ...linkedState,
      authorityStatus: "incompatible",
      authorityMessage:
        "This Connect link belongs to another account service; unlink and reconnect.",
      managedTunnelActive: false,
      publishAgentActivity: false,
    };
    await mountController();
    const ok = await reconcile({ managedTunnel: true, publish: false });
    expect(ok).toBe(false);
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
  });
  it.each(["cloudless", "partial", "locally-disabled"])(
    "allows paired local cleanup of %s state without managed sign-in or replacement",
    async (shape) => {
      testState.configured = shape !== "cloudless";
      testState.signedIn = false;
      testState.snapshot = {
        ...linkedState,
        linked: false,
        persistedLinkPresent: true,
        authorityStatus:
          shape === "cloudless"
            ? "cloudless"
            : shape === "locally-disabled"
              ? "unavailable"
              : "incompatible",
        locallyDisabled: shape === "locally-disabled",
        managedTunnelActive: false,
      };
      testState.renderedSnapshot = testState.snapshot;
      await mountController();
      expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
      expect(testState.getToken).not.toHaveBeenCalled();
      expectNoMutations();
      expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
      expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
      expect(testState.refreshDiscovery).not.toHaveBeenCalled();
    },
  );
  it("runs the visible partial cloudless cleanup button through the real controller without managed auth", async () => {
    testState.configured = false;
    testState.signedIn = false;
    testState.snapshot = {
      ...linkedState,
      linked: false,
      persistedLinkPresent: true,
      authorityStatus: "cloudless",
      managedTunnelActive: false,
      remoteCleanupPending: true,
    };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    const button = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      button.click();
    });
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.getToken).not.toHaveBeenCalled();
    expect(testState.refreshDiscovery).not.toHaveBeenCalled();
    expect(testState.link).not.toHaveBeenCalled();
  });
});
