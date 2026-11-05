import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({ canRead: true, id: "cloudless-state", reads: 0 }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => fixture.id,
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => fixture.canRead,
  readEnvironmentScope: () => fixture.canRead,
}));
vi.mock("./publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("./linkEnvironment", async () => {
  const Effect = await import("effect/Effect");
  return {
    readCloudLinkState: () =>
      Effect.sync(() => {
        fixture.reads++;
        return {
          linked: false,
          persistedLinkPresent: true,
          cloudUserId: null,
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: false,
          publishAgentActivity: false,
          authorityStatus: "cloudless",
          remoteCleanupPending: true,
        };
      }),
  };
});
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { usePrimaryCloudLinkState } from "./cloudLinkState";
let renderer: ReactTestRenderer | null = null;
let observed: ReturnType<typeof usePrimaryCloudLinkState> | null = null;
function Probe() {
  const state = usePrimaryCloudLinkState();
  useLayoutEffect(() => {
    observed = state;
  });
  return null;
}
beforeEach(() => {
  fixture.reads = 0;
  fixture.canRead = true;
  observed = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("reads cloudless saved local state through the paired scope using the real atom hook", async () => {
  fixture.id = "cloudless-readable";
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
  });
  expect(fixture.reads).toBe(1);
  expect(observed!.data).toMatchObject({
    persistedLinkPresent: true,
    remoteCleanupPending: true,
    authorityStatus: "cloudless",
  });
});
it("does not fetch or refresh local cleanup state without a paired read scope", async () => {
  fixture.id = "cloudless-denied";
  fixture.canRead = false;
  await act(async () => {
    renderer = create(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
  });
  expect(observed!.data).toBeNull();
  observed!.refresh();
  expect(fixture.reads).toBe(0);
});
