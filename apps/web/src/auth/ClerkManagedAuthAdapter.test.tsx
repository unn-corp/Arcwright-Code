import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useManagedAuth, type ManagedAuth } from "./managedAuthContext";

const state = vi.hoisted(() => ({
  electron: false,
  userId: "u1",
  sessionId: "s1",
  token: vi.fn(),
  openSignIn: vi.fn(),
  signOut: vi.fn(),
  openUserProfile: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: state.userId,
    sessionId: state.sessionId,
    getToken: state.token,
  }),
  useClerk: () => ({
    get session() {
      return { id: state.sessionId };
    },
    get user() {
      return { id: state.userId };
    },
    openSignIn: state.openSignIn,
    signOut: state.signOut,
    openUserProfile: state.openUserProfile,
  }),
}));
vi.mock("../env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("../cloud/publicConfig", () => ({
  resolveRelayClerkTokenOptions: () => ({ template: "fixture" }),
}));
import { ClerkManagedAuthAdapter } from "./ClerkManagedAuthAdapter";
let renderer: ReactTestRenderer | undefined;
let auth: ManagedAuth;
function Probe() {
  const current = useManagedAuth();
  useLayoutEffect(() => {
    auth = current;
  });
  return null;
}
async function render() {
  await act(async () => {
    if (renderer)
      renderer.update(
        <ClerkManagedAuthAdapter>
          <Probe />
        </ClerkManagedAuthAdapter>,
      );
    else
      renderer = create(
        <ClerkManagedAuthAdapter>
          <Probe />
        </ClerkManagedAuthAdapter>,
      );
  });
}
beforeEach(() => {
  state.electron = false;
  state.userId = "u1";
  state.sessionId = "s1";
  state.token.mockReset().mockResolvedValue("jwt");
  state.signOut.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("browser and Electron account adapter", () => {
  it("keeps each Clerk surface's configured token and account-modal capabilities", async () => {
    for (const electron of [false, true]) {
      state.electron = electron;
      await render();
      expect(auth.surface).toBe(electron ? "electron" : "browser");
      await expect(auth.getRelayToken()).resolves.toBe("jwt");
      expect(state.token).toHaveBeenLastCalledWith({ template: "fixture", skipCache: true });
      auth.openAccountPages?.([], "/t3-connect");
      expect(state.openUserProfile).toHaveBeenLastCalledWith({
        __experimental_startPath: "/t3-connect",
        customPages: [],
      });
    }
  });
  it("fences old token readers and pending renewal on account switch and immediate logout", async () => {
    let finish!: (token: string) => void;
    state.token.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    const previousReader = auth.getRelayToken;
    const pending = previousReader();
    state.userId = "u2";
    state.sessionId = "s2";
    await render();
    finish("stale");
    await expect(pending).resolves.toBeNull();
    await expect(previousReader()).resolves.toBeNull();
    const currentReader = auth.getRelayToken;
    await auth.signOut();
    await expect(currentReader()).resolves.toBeNull();
  });
});
