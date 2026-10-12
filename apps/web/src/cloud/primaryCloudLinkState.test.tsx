import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({ canRead: true, id: "cloudless-state", reads: 0 }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: fixture.id,
    label: "Direct",
    entry: {
      target: {
        _tag: "PrimaryConnectionTarget",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773/ws",
      },
    },
  }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => fixture.canRead,
  readEnvironmentScope: () => fixture.canRead,
}));
vi.mock("./publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../lib/runtime", async () => {
  const Effect = await import("effect/Effect");
  const Context = await import("effect/Context");
  const HttpClient = await import("effect/http/HttpClient");
  return {
    runtime: {
      contextEffect: Effect.succeed(
        Context.make(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused")),
        ),
      ),
    },
  };
});
vi.mock("./linkEnvironment", async () => {
  const Effect = await import("effect/Effect");
  return {
    readPrimaryCloudLinkState: () =>
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
import { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
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
