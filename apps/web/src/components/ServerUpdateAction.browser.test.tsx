import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AuthSessionState,
  FORK_ACTIVITY_PROTOCOL,
  type EnvironmentId,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type SessionValue = Atom.Type<
  ReturnType<(typeof import("~/state/session"))["environmentSession"]["sessionStateAtom"]>
>;
const state = vi.hoisted(() => ({
  action: vi.fn(),
  bulk: vi.fn(),
  toast: vi.fn(),
  session: null as SessionValue | null,
  sessionAtom: null as unknown as Atom.Writable<SessionValue>,
}));
vi.mock("../state/hostForkUpdates", () => ({
  hostForkUpdateController: () => ({ action: state.action }),
  requestHostUpdates: state.bulk,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: { ...actual.environmentSession, sessionStateAtom: () => state.sessionAtom },
  };
});
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);
const session = decodeSessionState({
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
    serverUpdateScope: "environment:maintain",
  },
});
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  serverUpdateStageLabel,
  ServerUpdateProgress,
} from "./ServerUpdateAction";
const capability = {
  protocol: 1 as const,
  coordinatorId: "device",
  participantId: "service",
  admission: true,
  activityProtocol: FORK_ACTIVITY_PROTOCOL,
  recovery: true,
};
const build = {
  version: "1.0.0",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
const waiting: ForkUpdateStatus = {
  coordinatorId: "device",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: build,
  targetBuild: build,
  blockers: [{ participantId: "dev", reason: "commands", label: "Dev command is working" }],
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
};
const target = {
  environmentId: "env-test" as EnvironmentId,
  serverLabel: "Laptop",
  selfUpdate: "boot-service" as const,
  forkMaintenance: capability,
  targetVersion: "1.0.0",
};
let container: HTMLDivElement;
let root: Root;
async function render(element: ReactNode) {
  await act(() => root.render(element));
}
function updateButton() {
  return container.querySelector<HTMLButtonElement>("button")!;
}
beforeEach(() => {
  state.action.mockReset().mockResolvedValue(waiting);
  state.bulk.mockReset();
  state.toast.mockReset();
  state.session = AsyncResult.success(session);
  state.sessionAtom = Atom.make<SessionValue>(state.session);
  appAtomRegistry.set(state.sessionAtom, state.session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
describe("server update actions", () => {
  it("offers bootstrap guidance when admission capability is absent", async () => {
    await render(<ServerUpdateAction {...target} forkMaintenance={undefined} />);
    expect(container.textContent).toContain("Bootstrap updater on");
    expect(container.querySelector("button")).toBeNull();
    expect(state.action).not.toHaveBeenCalled();
  });
  it("requests the verified artifact and reports waiting instead of installation", async () => {
    await render(<ServerUpdateAction {...target} />);
    await act(async () => updateButton().click());
    expect(state.action).toHaveBeenNthCalledWith(1, { action: "check" });
    expect(state.action).toHaveBeenNthCalledWith(2, {
      action: "install",
      targetArtifactSha256: build.artifactSha256,
    });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Laptop: waiting",
        description: expect.stringContaining("Dev command"),
      }),
    );
  });
  it("deduplicates pending requests and permits a later retry", async () => {
    let finish!: (value: ForkUpdateStatus) => void;
    state.action.mockImplementationOnce(
      () =>
        new Promise<ForkUpdateStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await render(<ServerUpdateAction {...target} />);
    await act(() => {
      updateButton().click();
      updateButton().click();
    });
    expect(state.action).toHaveBeenCalledOnce();
    await act(async () => finish({ ...waiting, targetBuild: null }));
    expect(state.toast).toHaveBeenCalledOnce();
    await act(async () => updateButton().click());
    expect(state.action).toHaveBeenCalledTimes(3);
  });
  it("routes bulk requests through coordinator grouping and reports each result", async () => {
    state.bulk.mockResolvedValue([
      { label: "Laptop", failed: false, message: "waiting" },
      { label: "Deck", failed: true, message: "Offline" },
    ]);
    await render(
      <ServerUpdatesAction
        targets={[
          target,
          { ...target, environmentId: "env-deck" as EnvironmentId, serverLabel: "Deck" },
        ]}
      />,
    );
    await act(async () => updateButton().click());
    expect(state.bulk).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Laptop",
      description: "waiting",
    });
    expect(state.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Deck",
      description: "Offline",
    });
  });
  it("keeps installation and restart progress distinct from downloading", async () => {
    expect(serverUpdateStageLabel("installing")).toBe("Installing…");
    expect(serverUpdateStageLabel("downloading")).toBe("Downloading…");
    await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(container.textContent).toBe("Installing…");
    await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(container.textContent).toBe("Restarting…");
  });
});
