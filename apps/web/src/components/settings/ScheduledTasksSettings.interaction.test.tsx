import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  toggle: vi.fn(),
  save: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
const environmentId = EnvironmentId.make("test-environment");
const projectId = ProjectId.make("test-project");
const environment = {
  environmentId,
  label: "Test computer",
  connection: { phase: "connected" },
  serverConfig: { environment: { platform: "linux" } },
};
let task: ScheduledTask;
let otherTask: ScheduledTask | null;
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/environments", () => ({ useEnvironment: () => environment }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: projectId, environmentId, title: "Project", workspaceRoot: "/fixture" },
  ],
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [environmentId], members: [] },
    environments: [environment],
    connectedEnvironments: [environment],
    environment,
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { tasks: otherTask ? [task, otherTask] : [task] },
    error: null,
  }),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    scheduledTasksLive: () => null,
    providersValueAtom: () => null,
    upsertScheduledTask: { permissionAtom: () => null, name: "save" },
    setScheduledTaskEnabled: { name: "toggle" },
    runScheduledTaskNow: { name: "run" },
    deleteScheduledTask: { name: "remove" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: ({ name }: { name: "save" | "toggle" | "run" | "remove" }) => commands[name],
}));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => [],
  applyProviderInstanceSettings: () => [],
  sortProviderInstanceEntries: () => [],
}));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => ({}) }));
vi.mock("./scheduledTasksSettings.logic", async (original) => ({
  ...(await original<typeof import("./scheduledTasksSettings.logic")>()),
  scheduledTaskDefaultModel: () => task.modelSelection,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../WorktreeBaseBranchPicker", () => ({ WorktreeBaseBranchPicker: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: commands.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => "Command failed",
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  useRelativeTimeTick: () => undefined,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    onCheckedChange,
    checked,
    ...props
  }: React.ComponentProps<"input"> & {
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      onChange={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock("../ui/select", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Select: Wrapper,
    SelectTrigger: Wrapper,
    SelectValue: Wrapper,
    SelectPopup: Wrapper,
    SelectItem: Wrapper,
  };
});
vi.mock("../ui/menu", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Menu: Wrapper,
    MenuTrigger: () => null,
    MenuPopup: Wrapper,
    MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button onClick={onClick}>{children}</button>
    ),
    MenuSeparator: () => null,
  };
});

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

let renderer: ReactTestRenderer;
function deferred() {
  let resolve!: (result: { _tag: "Success" | "Failure" }) => void;
  const promise = new Promise<{
    _tag: "Success" | "Failure";
    value?: { task: ScheduledTask };
  }>((done) => {
    resolve = (result) =>
      done(
        result._tag === "Success"
          ? { ...result, value: { task: { ...task, enabled: !task.enabled } } }
          : result,
      );
  });
  return { promise, resolve };
}
const success = { _tag: "Success" } as const;
function saveButton() {
  return renderer.root.findAllByType("button").find((node) => node.children.includes("Save task"))!;
}
function headerToggle() {
  return renderer.root
    .findAllByType("input")
    .find(
      (node) => node.props["aria-label"] === `${task.enabled ? "Pause" : "Resume"} ${task.title}`,
    )!;
}
function prompt() {
  return renderer.root.findByType("textarea");
}
async function open(enabled = true) {
  task = { ...task, enabled };
  await act(() => {
    renderer = create(<ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />);
  });
}
async function editPrompt(value = "Unsaved instructions") {
  await act(() => prompt().props.onChange({ target: { value } }));
}
beforeEach(() => {
  otherTask = null;
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  task = {
    id: ScheduledTaskId.make("test-task"),
    title: "Review issues",
    prompt: "Original instructions",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  commands.save.mockResolvedValue({ ...success, value: { task } });
  commands.run.mockResolvedValue(success);
  commands.remove.mockResolvedValue(success);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "preserves a successful header toggle from enabled=%s through editing and saving",
  async (enabled) => {
    const toggle = deferred();
    commands.toggle.mockReturnValue(toggle.promise);
    await open(enabled);
    await editPrompt();
    await act(() => headerToggle().props.onChange());
    expect(commands.toggle).toHaveBeenCalledWith({
      environmentId,
      input: { id: task.id, enabled: !enabled },
    });
    await act(() => {
      toggle.resolve(success);
    });
    expect(prompt().props.value).toBe("Unsaved instructions");
    await editPrompt("Updated instructions");
    await act(() => saveButton().props.onClick());
    expect(commands.save).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        enabled: !enabled,
        prompt: "Updated instructions",
        requireExisting: true,
      }),
    });
  },
);

it.each([true, false])(
  "preserves enabled=%s and the pending prompt when the header toggle fails",
  async (enabled) => {
    const toggle = deferred();
    commands.toggle.mockReturnValue(toggle.promise);
    await open(enabled);
    await editPrompt();
    await act(() => headerToggle().props.onChange());
    await act(() => {
      toggle.resolve({ _tag: "Failure" });
    });
    expect(commands.toast).toHaveBeenCalledTimes(1);
    expect(prompt().props.value).toBe("Unsaved instructions");
    await act(() => saveButton().props.onClick());
    expect(commands.save).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ enabled, prompt: "Unsaved instructions" }),
    });
  },
);

it.each(["toggle", "run", "remove"] as const)(
  "blocks saves synchronously and while header %s is pending",
  async (action) => {
    const operation = deferred();
    commands[action].mockReturnValue(operation.promise);
    await open();
    const save = saveButton().props.onClick;
    const start =
      action === "toggle"
        ? headerToggle().props.onChange
        : renderer.root
            .findAllByType("button")
            .find((node) => node.children.includes(action === "run" ? "Run now" : "Delete"))!.props
            .onClick;
    await act(() => {
      start();
      save();
    });
    expect(commands[action]).toHaveBeenCalledTimes(1);
    expect(commands.save).not.toHaveBeenCalled();
    expect(saveButton().props.disabled).toBe(true);
    expect(renderer.root.findByType("fieldset").props.disabled).toBe(true);
    await act(() => saveButton().props.onClick());
    expect(commands.save).not.toHaveBeenCalled();
    await act(() => {
      operation.resolve(success);
    });
    await act(() => saveButton().props.onClick());
    expect(commands.save).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ enabled: action !== "toggle" }),
    });
  },
);

it("blocks header toggle, Run, and Delete synchronously and while saving", async () => {
  const save = deferred();
  commands.save.mockReturnValue(save.promise);
  await open();
  const toggle = headerToggle().props.onChange;
  const run = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes("Run now"))!.props.onClick;
  const remove = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes("Delete"))!.props.onClick;
  await act(() => {
    saveButton().props.onClick();
    toggle();
    run();
    remove();
  });
  await act(() => {
    headerToggle().props.onChange();
    run();
    remove();
  });
  expect(headerToggle().props.disabled).toBe(true);
  expect(commands.toggle).not.toHaveBeenCalled();
  expect(commands.run).not.toHaveBeenCalled();
  expect(commands.remove).not.toHaveBeenCalled();
  await act(() => {
    save.resolve({ _tag: "Failure" });
  });
  commands.toggle.mockResolvedValue({ ...success, value: { task: { ...task, enabled: false } } });
  await act(() => headerToggle().props.onChange());
  expect(commands.toggle).toHaveBeenCalledTimes(1);
});

it("opens the successful pause result before the live list refreshes", async () => {
  const toggle = deferred();
  commands.toggle.mockReturnValue(toggle.promise);
  await act(() => {
    renderer = create(<ScheduledTasksSettings environmentId={environmentId} />);
  });
  const title = () =>
    renderer.root.findAllByType("button").find((node) => node.children.includes(task.title))!;
  const openDetails = title().props.onClick;
  await act(() => {
    headerToggle().props.onChange();
    openDetails();
  });
  expect(title().props.disabled).toBe(true);
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  await act(() => title().props.onClick());
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  await act(() => {
    toggle.resolve(success);
  });
  await act(() => title().props.onClick());
  await act(() =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Back to Scheduled Tasks"))!
      .props.onClick(),
  );
  await act(() => title().props.onClick());
  await act(() => {
    task = { ...task, enabled: false };
    renderer.update(<ScheduledTasksSettings environmentId={environmentId} />);
  });
  await editPrompt();
  await act(() => saveButton().props.onClick());
  expect(commands.save).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ enabled: false, prompt: "Unsaved instructions" }),
  });
});

it("opens a new task link while details are open and allows returning to the first link", async () => {
  await open();
  otherTask = { ...task, id: ScheduledTaskId.make("other-task"), prompt: "Other instructions" };
  await editPrompt();
  await act(() =>
    renderer.update(
      <ScheduledTasksSettings environmentId={environmentId} taskId={otherTask!.id} />,
    ),
  );
  expect(prompt().props.value).toBe("Other instructions");
  await act(() =>
    renderer.update(<ScheduledTasksSettings environmentId={environmentId} taskId={task.id} />),
  );
  expect(prompt().props.value).toBe("Original instructions");
  expect(commands.save).not.toHaveBeenCalled();
});
