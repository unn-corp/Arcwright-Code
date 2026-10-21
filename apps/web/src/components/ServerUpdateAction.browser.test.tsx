import { act, render as renderUi, type Screen } from "../../test/render";
import { useState, type ReactNode } from "react";
import {
  AuthSessionState,
  FORK_ACTIVITY_PROTOCOL,
  type EnvironmentId,
  type ForkUpdateStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

import {
  ServerUpdateAction,
  ServerUpdatesAction,
  ServerUpdateProgress,
  serverUpdateStageLabel,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

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
async function render(root: Screen, element: ReactNode) {
  await act(() => root.rerender(element));
}
function updateButton(root: Screen) {
  return root.container.querySelector<HTMLButtonElement>("button")!;
}
async function setup() {
  resetConfirmDialogForTests();
  state.action.mockReset().mockResolvedValue(waiting);
  state.bulk.mockReset();
  state.toast.mockReset();
  state.session = AsyncResult.success(session);
  state.sessionAtom = Atom.make<SessionValue>(state.session);
  appAtomRegistry.set(state.sessionAtom, state.session);
  // Navigation is mocked; this fixture exercises only the panel or bridge.
  const root = await renderUi(null, { router: false });
  return {
    root,
    container: root.container,
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      resetConfirmDialogForTests();
    },
  };
}

describe("server update actions", () => {
  it("offers bootstrap guidance when admission capability is absent", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await render(root, <ServerUpdateAction {...target} forkMaintenance={undefined} />);
    expect(container.textContent).toContain("Bootstrap updater on");
    expect(container.querySelector("button")).toBeNull();
    expect(state.action).not.toHaveBeenCalled();
  });
  it("requests the verified artifact and reports waiting instead of installation", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await render(root, <ServerUpdateAction {...target} />);
    await act(async () => updateButton(root).click());
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
    await using _fixture = await setup();
    const { root, container } = _fixture;
    let finish!: (value: ForkUpdateStatus) => void;
    state.action.mockImplementationOnce(
      () =>
        new Promise<ForkUpdateStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await render(root, <ServerUpdateAction {...target} />);
    await act(() => {
      updateButton(root).click();
      updateButton(root).click();
    });
    expect(state.action).toHaveBeenCalledOnce();
    await act(async () => finish({ ...waiting, targetBuild: null }));
    expect(state.toast).toHaveBeenCalledOnce();
    await act(async () => updateButton(root).click());
    expect(state.action).toHaveBeenCalledTimes(3);
  });
  it("routes bulk requests through coordinator grouping and reports each result", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    state.bulk.mockResolvedValue([
      { label: "Laptop", failed: false, message: "waiting" },
      { label: "Deck", failed: true, message: "Offline" },
    ]);
    await render(
      root,
      <ServerUpdatesAction
        targets={[
          target,
          { ...target, environmentId: "env-deck" as EnvironmentId, serverLabel: "Deck" },
        ]}
      />,
    );
    await act(async () => updateButton(root).click());
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
    await using _fixture = await setup();
    const { root, container } = _fixture;
    expect(serverUpdateStageLabel("installing")).toBe("Installing…");
    expect(serverUpdateStageLabel("downloading")).toBe("Downloading…");
    await render(
      root,
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
      root,
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

describe("server updates from the environment selector", () => {
  const localId = "env-test" as EnvironmentId;
  const otherId = "update-server" as EnvironmentId;
  const availableEnvironments = [
    { environmentId: localId, label: "Build box", isPrimary: true },
    { environmentId: otherId, label: "Other machine", isPrimary: false },
  ].map((environment) => ({ ...environment, projectId: null, machine: "server" as const }));
  const serverUpdate = {
    environmentId: localId,
    serverLabel: "Build box",
    serverVersion: "0.0.30",
    targetVersion: "0.0.31",
    selfUpdate: "desktop-managed",
    desktopAppUpdate: true,
    forkMaintenance: capability,
  } satisfies ServerUpdateTarget & { serverVersion: string };

  it("confirms a locked chip update and honors cancellation before updating", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    registerConfirmDialogHost();
    await render(
      root,
      <BranchToolbarEnvironmentSelector
        environmentId={localId}
        availableEnvironments={availableEnvironments}
        envLocked
        serverUpdate={serverUpdate}
      />,
    );
    const chip = page.getByRole("button", { name: /Build box|Update/ });
    await userEvent.click(chip);
    expect(readConfirmDialogState()).toMatchObject({
      status: "confirming",
      message: expect.stringContaining("Build box"),
    });
    expect(state.action).not.toHaveBeenCalled();
    await act(async () => {
      respondToConfirmDialog(false);
      completeConfirmDialogClose();
    });
    expect(state.action).not.toHaveBeenCalled();
    await userEvent.click(chip);
    await act(async () => respondToConfirmDialog(true));
    expect(state.action).toHaveBeenCalledWith({ action: "check" });
    expect(state.action).toHaveBeenCalledWith({
      action: "install",
      targetArtifactSha256: build.artifactSha256,
    });
  });

  it("keeps unsupported hosts visible without bypassing admission and selects an action-like environment ID", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    const update = { ...serverUpdate, selfUpdate: null, installation: { kind: "npx" } } as const;
    function Picker() {
      const [environmentId, setEnvironmentId] = useState(localId);
      return (
        <BranchToolbarEnvironmentSelector
          environmentId={environmentId}
          availableEnvironments={availableEnvironments}
          envLocked={false}
          onEnvironmentChange={setEnvironmentId}
          serverUpdate={environmentId === localId ? update : null}
        />
      );
    }
    await render(root, <Picker />);
    const picker = page.getByRole("combobox", { name: "Run on" });
    await userEvent.click(picker);
    await expect.element(page.getByRole("option", { name: "Other machine" })).toBeVisible();
    expect(state.action).not.toHaveBeenCalled();
    const bootstrap = page.getByRole("option", { name: /Bootstrap updater on/ });
    await expect.element(bootstrap).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(bootstrap, { force: true });
    expect(state.action).not.toHaveBeenCalled();
    await expect.element(picker).toHaveTextContent("Build box");
    await expect
      .element(page.getByRole("option", { name: "Build box", exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(page.getByRole("option", { name: "Other machine" }));
    await expect.element(picker).toHaveTextContent("Other machine");
    expect(state.action).not.toHaveBeenCalled();
  });

  it("explains an unsupported desktop update in the picker without offering a runnable action", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    registerConfirmDialogHost();
    await render(
      root,
      <BranchToolbarEnvironmentSelector
        environmentId={localId}
        availableEnvironments={availableEnvironments}
        envLocked={false}
        onEnvironmentChange={vi.fn()}
        serverUpdate={{ ...serverUpdate, desktopAppUpdate: false }}
      />,
    );
    await userEvent.click(page.getByRole("combobox", { name: "Run on" }));
    const instruction = page.getByRole("option", { name: /Bootstrap updater on/ });
    await expect.element(instruction).toBeVisible();
    await expect.element(instruction).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(instruction, { force: true });
    expect(readConfirmDialogState().status).toBe("idle");
    expect(state.action).not.toHaveBeenCalled();
    expect(state.action).not.toHaveBeenCalled();
  });
});
