import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ForkUpdateStatus } from "@t3tools/contracts";

import { ForkUpdateController } from "../../state/forkUpdates";
import { ForkUpdateControls } from "./ForkUpdateControls";

vi.mock("./settingsLayout", () => ({
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.status}
      {props.control}
      {props.children}
    </section>
  ),
}));
vi.mock("./UpdateSafetyReviewDialog", () => ({ UpdateSafetyReviewDialog: () => null }));
vi.mock("./UpdateRecoveryDialog", () => ({ UpdateRecoveryDialog: () => null }));

const build = {
  version: "1.0.1-nightly.20261008.70",
  forkBuildNumber: 70,
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
const target = { ...build, forkBuildNumber: 81, artifactSha256: "c".repeat(64) };
const waiting: ForkUpdateStatus = {
  coordinatorId: "isolated-device",
  phase: "waiting",
  currentBuild: build,
  targetBuild: target,
  blockers: [
    {
      participantId: "old-runtime",
      reason: "unknown-participant",
      label: "Activity has not been verified.",
    },
  ],
  policy: { channel: "nightly", automaticInstallation: true, pinnedBuild: null },
  recoveryOptions: [],
  transactionId: null,
  automationReviewRequired: false,
  installable: false,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(text: string) {
  return [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;
}
async function mount(controller: ForkUpdateController) {
  await act(async () =>
    root.render(<ForkUpdateControls controller={controller} device="Devotek-PC" />),
  );
}
function fixture(status = waiting) {
  const action = vi.fn(async () => status);
  const controller = new ForkUpdateController({
    status: async () => status,
    action,
    policy: async () => status,
    recover: async () => status,
  });
  return { controller, action };
}

it("shows the blocked install reason alongside a feed error and refuses a disabled click", async () => {
  const f = fixture({
    ...waiting,
    lastError: "GitHub rate limit exceeded; retry after 18:41 UTC.",
  });
  await mount(f.controller);
  expect(container.textContent).toContain("GitHub rate limit exceeded");
  expect(container.textContent).toContain("Activity has not been verified.");
  expect(container.textContent).toContain(
    "Installation is waiting: A registered runtime cannot be verified.",
  );
  expect(button("Update now").disabled).toBe(true);
  await act(async () => button("Update now").click());
  expect(f.action).not.toHaveBeenCalled();
});

it("shows check progress and a persistent result even when the host remains waiting", async () => {
  const f = fixture();
  let resolve!: (status: ForkUpdateStatus) => void;
  f.action.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount(f.controller);
  await act(async () => button("Check and download").click());
  expect(button("Checking and downloading…").disabled).toBe(true);
  await act(async () => resolve(waiting));
  expect(f.action).toHaveBeenCalledExactlyOnceWith({ action: "check" });
  expect(container.textContent).toContain("Check completed. Waiting to install");
  await act(async () => {
    await f.controller.refresh();
  });
  expect(container.textContent).toContain("Check completed. Waiting to install");
  expect(container.textContent).not.toContain("Update completed");
  await act(async () =>
    f.controller.accept({
      ...waiting,
      phase: "installing",
      blockers: [],
    }),
  );
  expect(container.textContent).not.toContain("Check completed. Waiting to install");
  expect(container.textContent).toContain("Installing…");
});

it("binds install to the verified digest and reports waiting without claiming completion", async () => {
  const f = fixture({
    ...waiting,
    installable: true,
    blockers: [
      { participantId: "device", reason: "idle-window", label: "Waiting for five idle minutes." },
    ],
  });
  await mount(f.controller);
  await act(async () => button("Update now").click());
  expect(f.action).toHaveBeenCalledExactlyOnceWith({
    action: "install",
    targetArtifactSha256: target.artifactSha256,
  });
  expect(container.textContent).toContain("Installation has not started.");
  expect(container.textContent).not.toContain("Update completed");
});

it("keeps a failed button action visible after a successful status poll", async () => {
  const f = fixture();
  f.action.mockRejectedValueOnce(new Error("Host permission denied"));
  await mount(f.controller);
  await act(async () => button("Check and download").click());
  expect(container.textContent).toContain("Host permission denied");
  await act(async () => {
    await f.controller.refresh();
  });
  expect(container.textContent).toContain("Host permission denied");
  await act(async () => button("Check and download").click());
  expect(container.textContent).not.toContain("Host permission denied");
  expect(container.textContent).toContain("Check completed.");
});

it("updates without a warning when no sessions are running", async () => {
  const f = fixture({ ...waiting, installable: true, blockers: [] });
  await mount(f.controller);
  await act(async () => button("Update now").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(f.action).toHaveBeenCalledExactlyOnceWith({
    action: "install",
    targetArtifactSha256: target.artifactSha256,
  });
});

it("warns only for running work and cancellation does not interrupt it", async () => {
  const f = fixture({
    ...waiting,
    interruptible: true,
    blockers: [
      { participantId: "runtime", reason: "active-agents", label: "A session is running." },
    ],
  });
  await mount(f.controller);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Update now").disabled).toBe(false);
  await act(async () => button("Update now").click());
  expect(document.body.textContent).toContain("Interrupt sessions and update?");
  expect(f.action).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(f.action).not.toHaveBeenCalled();
});

it("confirmation authorizes interruption only for the reviewed artifact", async () => {
  const f = fixture({
    ...waiting,
    interruptible: true,
    blockers: [
      { participantId: "runtime", reason: "active-agents", label: "A session is running." },
    ],
  });
  await mount(f.controller);
  await act(async () => button("Update now").click());
  await act(async () => button("Interrupt and update").click());
  expect(f.action).toHaveBeenCalledExactlyOnceWith({
    action: "install",
    targetArtifactSha256: target.artifactSha256,
    interruptActiveWork: true,
  });
});

it("refuses a changed target while the interruption warning is open", async () => {
  let status: ForkUpdateStatus = {
    ...waiting,
    interruptible: true,
    blockers: [
      { participantId: "runtime", reason: "active-agents", label: "A session is running." },
    ],
  };
  const action = vi.fn(async () => status);
  const controller = new ForkUpdateController({
    status: async () => status,
    action,
    policy: async () => status,
    recover: async () => status,
  });
  await mount(controller);
  await act(async () => button("Update now").click());
  status = { ...status, targetBuild: { ...target, artifactSha256: "d".repeat(64) } };
  await act(async () => button("Interrupt and update").click());
  expect(action).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("The update changed.");
});
