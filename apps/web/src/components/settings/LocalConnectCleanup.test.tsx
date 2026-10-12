import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { LocalConnectCleanup } from "./LocalConnectCleanup";
const base: EnvironmentCloudLinkStateResult = {
  linked: false,
  persistedLinkPresent: true,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  managedTunnelActive: false,
  publishAgentActivity: false,
  authorityStatus: "cloudless",
};
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["cloudless", "incompatible"] as const)(
  "cleans partial %s saved state through its paired action and keeps pending feedback visible",
  async (authorityStatus) => {
    let state = { ...base, authorityStatus };
    const unlink = vi.fn(async () => {
      state = { ...state, persistedLinkPresent: false, remoteCleanupPending: true };
      return true;
    });
    const view = () => (
      <LocalConnectCleanup state={state} canManage pending={false} unlink={unlink} />
    );
    await act(() => {
      renderer = create(view());
    });
    const button = renderer!.root.findByType("button");
    expect(button.props.children).toBe("Unlink locally");
    await act(async () => {
      await button.props.onClick();
      renderer!.update(view());
    });
    expect(unlink).toHaveBeenCalledOnce();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Remote cleanup pending");
  },
);
it("disables local cleanup without direct management permission", async () => {
  const unlink = vi.fn(async () => true);
  await act(() => {
    renderer = create(
      <LocalConnectCleanup state={base} canManage={false} pending={false} unlink={unlink} />,
    );
  });
  const button = renderer!.root.findByType("button");
  await act(async () => {
    await button.props.onClick();
  });
  expect(unlink).not.toHaveBeenCalled();
});
