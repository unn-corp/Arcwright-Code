import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import * as Exit from "effect/Exit";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ManagedAuth } from "../auth/managedAuthContext";

const state = vi.hoisted(() => ({
  auth: null as ManagedAuth | null,
  remove: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../auth/managedAuthContext", () => ({ useManagedAuth: () => state.auth }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: { label: "remove relay environments", run: state.remove },
  },
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromiseExit: state.reset } }));
import { appAtomRegistry } from "../rpc/atomRegistry";
import { ManagedRelayAuthProvider, deactivateManagedRelayAuthentication } from "./managedAuth";
let renderer: ReactTestRenderer | undefined;
function account(userId: string | null, generation: number): ManagedAuth {
  return {
    surface: "android",
    isLoaded: true,
    isSignedIn: userId !== null,
    userId,
    sessionId: userId ? `session-${userId}` : null,
    generation,
    error: null,
    isSigningIn: false,
    getRelayToken: async () => `${userId}-token`,
    openSignIn: () => {},
    signOut: async () => {},
    openAccountPages: null,
  };
}
async function render(auth: ManagedAuth) {
  state.auth = auth;
  await act(async () => {
    if (renderer)
      renderer.update(
        <ManagedRelayAuthProvider>
          <div />
        </ManagedRelayAuthProvider>,
      );
    else
      renderer = create(
        <ManagedRelayAuthProvider>
          <div />
        </ManagedRelayAuthProvider>,
      );
  });
}
beforeEach(() => {
  state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.reset.mockReset().mockResolvedValue(Exit.succeed(undefined));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  deactivateManagedRelayAuthentication();
});

describe("shared managed account lifecycle", () => {
  it("holds catalog cleanup until authoritative readiness and preserves account on transient errors", async () => {
    await render({ ...account(null, 0), isLoaded: false, error: "Offline" });
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    await render(account("one", 1));
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("one");
    await render({ ...account("one", 1), isLoaded: false, error: "Offline" });
    expect(state.remove).not.toHaveBeenCalled();
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("one");
    await render(account(null, 2));
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.reset).toHaveBeenCalledOnce();
  });
  it("deactivates before account cleanup and never activates a superseded queued account", async () => {
    await render(account("one", 1));
    let finish!: () => void;
    state.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ _tag: "Success", value: undefined });
        }),
    );
    await render(account("two", 2));
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await render(account("three", 3));
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await act(async () => finish());
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("three");
    expect(state.remove).toHaveBeenCalledTimes(2);
  });
});
