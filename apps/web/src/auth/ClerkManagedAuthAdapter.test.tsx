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
  setProfileImage: vi.fn(),
  reload: vi.fn(),
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
      return { id: state.userId, setProfileImage: state.setProfileImage, reload: state.reload };
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
  state.setProfileImage.mockReset().mockResolvedValue(undefined);
  state.reload
    .mockReset()
    .mockResolvedValue({ hasImage: true, imageUrl: "https://example.test/current.png" });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("browser and Electron account adapter", () => {
  it("writes account thumbnails and removal through Clerk on both surfaces", async () => {
    for (const electron of [false, true]) {
      state.electron = electron;
      await render();
      await expect(auth.setProfilePhoto!("data:image/webp;base64,AA==")).resolves.toBe(
        "https://example.test/current.png",
      );
      expect(state.setProfileImage).toHaveBeenLastCalledWith({
        file: "data:image/webp;base64,AA==",
      });
      state.reload.mockResolvedValueOnce({
        hasImage: false,
        imageUrl: "https://example.test/default.png",
      });
      await expect(auth.setProfilePhoto!(null)).resolves.toBeNull();
      expect(state.setProfileImage).toHaveBeenLastCalledWith({ file: null });
    }
    await expect(auth.setProfilePhoto!("https://arbitrary.test/image")).rejects.toThrow("bounded");
  });
  it("does not publish a photo response across account replacement or logout", async () => {
    let finish!: () => void;
    state.setProfileImage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    const update = auth.setProfilePhoto!(null);
    await Promise.resolve();
    state.userId = "u2";
    state.sessionId = "s2";
    await render();
    finish();
    await expect(update).rejects.toThrow("Account changed");
    expect(state.reload).not.toHaveBeenCalled();
    const stale = auth.setProfilePhoto!;
    await auth.signOut();
    await expect(stale(null)).rejects.toThrow("Account changed");
  });
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
