import {
  OrganizationId,
  OrganizationRoleId,
  OrganizationArchitectMessageId,
  OrganizationArchitectProposalId,
  type Organization,
  type OrganizationArchitectListResult,
  type OrganizationArchitectProposal,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { OrganizationArchitectConversation } from "./OrganizationArchitectConversation";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  refresh: vi.fn(),
  profiles: true,
  emptyPreferredModels: false,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? { environment: { capabilities: { organizationEmployeeProfiles: mocks.profiles } } }
      : [],
}));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: "providers",
  primaryServerConfigAtom: "config",
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => ({
    textGenerationModelSelection: { instanceId: "codex", model: "model" },
  }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({ networkStatus: "online" }),
}));
vi.mock("../../state/organizations", () => ({
  organizationEnvironment: { architectList: vi.fn(), architectSend: "send" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.send }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => query }));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => [],
  applyProviderInstanceSettings: () => [
    {
      instanceId: "codex",
      displayName: "Codex",
      enabled: true,
      isAvailable: true,
      installed: true,
      status: "ready",
      snapshot: { supportsTextGeneration: true },
    },
    {
      instanceId: "alternate",
      displayName: "Alternate",
      enabled: true,
      isAvailable: true,
      installed: true,
      status: "ready",
      snapshot: { supportsTextGeneration: true },
    },
  ],
}));
vi.mock("../../modelSelection", () => ({
  getAppModelOptionsForInstance: (_settings: unknown, entry: { instanceId: string }) =>
    mocks.emptyPreferredModels && entry.instanceId === "codex"
      ? []
      : [{ slug: "model", name: "Model" }],
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    onInstanceModelChange,
    disabled,
  }: {
    onInstanceModelChange: (instanceId: string, model: string) => void;
    disabled: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onInstanceModelChange("alternate", "model")}
    >
      Choose alternate provider
    </button>
  ),
}));

const organization: Organization = {
  id: OrganizationId.make("team"),
  title: "Team",
  mission: "Build",
  lifecycle: "draft",
  draftRevision: 1,
  publishedRevision: null,
  architectRoleId: OrganizationRoleId.make("architect"),
  directorRoleId: OrganizationRoleId.make("director"),
  graph: { roles: [], edges: [] },
  workflows: [],
  layout: { positions: [] },
  bindings: [],
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};
const emptyHistory: OrganizationArchitectListResult = {
  messages: [],
  proposals: [],
  requests: [],
  appliedProposalIds: [],
};
const query = {
  data: emptyHistory,
  isPending: false,
  isSuccess: true,
  error: null,
  refresh: mocks.refresh,
};
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof OrganizationArchitectConversation>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.send.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.refresh.mockReset();
  mocks.profiles = true;
  mocks.emptyPreferredModels = false;
  query.data = emptyHistory;
  props = { organization, offline: false, busy: false, onApplyBatch: vi.fn(async () => true) };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<OrganizationArchitectConversation {...props} />));
}
function element<T extends Element = HTMLElement>(selector: string) {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function button(name: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
function composer() {
  return element<HTMLTextAreaElement>('textarea[aria-label="Message Architect"]');
}
async function input(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      composer(),
      value,
    );
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function enter(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => {
    composer().dispatchEvent(event);
  });
  return event;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
function deferredSend() {
  const pending = deferred<{ _tag: "Success"; value: undefined }>();
  mocks.send.mockReturnValue(pending.promise);
  return pending;
}
function proposals(changes: OrganizationArchitectProposal["change"][]) {
  const responseMessageId = OrganizationArchitectMessageId.make("reply");
  query.data = {
    ...emptyHistory,
    messages: [
      {
        id: responseMessageId,
        organizationId: organization.id,
        requestId: OrganizationArchitectMessageId.make("request"),
        role: "architect",
        text: "Here are my suggestions.",
        baseRevision: 1,
        modelSelection: null,
        createdAt: organization.createdAt,
      },
    ],
    proposals: changes.map((change, index) => ({
      id: OrganizationArchitectProposalId.make(`proposal-${index}`),
      organizationId: organization.id,
      responseMessageId,
      baseRevision: 1,
      change,
      createdAt: organization.createdAt,
    })),
  };
}

it("shows the sent message immediately, clears the composer, and preserves the next draft after success", async () => {
  const pending = deferredSend();
  await render();
  await input("  Build a helpful team  ");
  await click("Send message to Architect");
  expect(element('[aria-label="Your message"]').textContent).toContain("Build a helpful team");
  expect(composer().value).toBe("");
  expect(composer().disabled).toBe(false);
  expect(element('[role="log"]').getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("You can draft your next message while waiting.");
  expect(button("Send message to Architect").disabled).toBe(true);
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        text: "Build a helpful team",
        baseRevision: 1,
        modelSelection: { instanceId: "codex", model: "model" },
      }),
    }),
  );
  await input("Next question");
  await enter();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ _tag: "Success", value: undefined }));
  expect(composer().value).toBe("Next question");
  expect(button("Send message to Architect").disabled).toBe(false);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("retains the failed message and restores it when the composer is empty", async () => {
  const pending = deferred<never>();
  mocks.send.mockReturnValue(pending.promise);
  await render();
  await input("Retry this question");
  await enter();
  await act(async () => pending.reject(new Error("Connection lost")));
  expect(composer().value).toBe("Retry this question");
  expect(element('[role="alert"]').textContent).toContain("Connection lost");
  expect(element('[aria-label="Your message"]').textContent).toContain("Retry this question");
  expect(element('[aria-label="Your message"]').textContent).toContain("Connection lost");
  expect(button("Use message again").disabled).toBe(false);
  expect(element('[role="log"]').getAttribute("aria-busy")).toBe("false");
});

it.each(["command failure", "thrown failure"] as const)(
  "retains failed message A and draft B after %s and restores A only into an empty composer",
  async (failureKind) => {
    const pending = deferred<{ _tag: "Failure"; cause: Cause.Cause<Error> }>();
    mocks.send.mockReturnValue(pending.promise);
    await render();
    await input("First question A");
    await enter();
    await input("Keep this next question B");
    await act(async () => {
      const error = new Error("Unavailable");
      if (failureKind === "command failure")
        pending.resolve({ _tag: "Failure", cause: Cause.fail(error) });
      else pending.reject(error);
    });
    expect(composer().value).toBe("Keep this next question B");
    const failedMessage = element('[aria-label="Your message"]');
    expect(failedMessage.textContent).toContain("First question A");
    expect(failedMessage.textContent).toContain("Unavailable");
    expect(failedMessage.textContent).toContain("Couldn’t complete reply");
    expect(element('[role="alert"]').textContent).toContain("Unavailable");
    expect(element('[role="log"]').getAttribute("aria-busy")).toBe("false");
    await click("Use message again");
    expect(composer().value).toBe("Keep this next question B");
    expect(element('[role="alert"]').textContent).toContain("Your current draft is kept");
    expect(failedMessage.textContent).toContain("First question A");
    await input("");
    await click("Use message again");
    expect(composer().value).toBe("First question A");
    expect(failedMessage.textContent).toContain("First question A");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  },
);

it("allows Shift+Enter and IME composition, ignores repeat, and sends once on Enter", async () => {
  const pending = deferredSend();
  await render();
  await input("A question");
  expect((await enter({ shiftKey: true })).defaultPrevented).toBe(false);
  expect((await enter({ isComposing: true })).defaultPrevented).toBe(false);
  await enter({ repeat: true });
  expect(mocks.send).not.toHaveBeenCalled();
  expect((await enter()).defaultPrevented).toBe(true);
  await act(async () => {
    composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    element("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ _tag: "Success", value: undefined }));
});

it("sends the setup starter directly while preserving an unrelated draft", async () => {
  await render();
  await input("My unsent idea");
  await click("Guide me through setup");
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        text: expect.stringContaining("Walk me through designing and setting up"),
      }),
    }),
  );
  expect(element('[aria-label="Your message"]').textContent).toContain("Walk me through");
  expect(composer().value).toBe("My unsent idea");
});

it("requires explicit review and Apply and previews complete employee profile text", async () => {
  const personality = "Thoughtful and direct. ".repeat(30) + "Personality ending";
  const focus = "Reliable handoffs. ".repeat(30) + "Focus ending";
  const skills = "TypeScript and testing. ".repeat(30) + "Skills ending";
  proposals([
    {
      type: "add-role",
      role: {
        id: OrganizationRoleId.make("engineer"),
        kind: "engineering",
        title: "Engineer",
        mandate: "Build",
        poolSize: 1,
        personality,
        focus,
        skills,
      },
    },
  ]);
  await render();
  const review = element<HTMLDetailsElement>('article[aria-label="Architect reply"] details');
  expect(review.open).toBe(false);
  expect(props.onApplyBatch).not.toHaveBeenCalled();
  await act(async () => element("summary").click());
  expect(review.open).toBe(true);
  expect(review.textContent).toContain(personality);
  expect(review.textContent).toContain(focus);
  expect(review.textContent).toContain(skills);
  await click("Apply to draft");
  expect(props.onApplyBatch).toHaveBeenCalledExactlyOnceWith(query.data.proposals);
  expect(review.textContent).toContain("Applied");
  expect(review.querySelector("button")).toBeNull();
});

it("disables individual and batch Apply after the draft revision changes", async () => {
  proposals([
    { type: "set-title", title: "New team" },
    { type: "set-mission", mission: "New mission" },
  ]);
  await render();
  props = { ...props, organization: { ...organization, draftRevision: 2 } };
  await render();
  expect(button("Apply all 2 to draft").disabled).toBe(true);
  for (const apply of Array.from(container.querySelectorAll("button")).filter(
    (entry) => entry.textContent === "Apply to draft",
  )) {
    expect(apply.disabled).toBe(true);
    await act(async () => apply.click());
  }
  await click("Apply all 2 to draft");
  expect(props.onApplyBatch).not.toHaveBeenCalled();
  expect(container.textContent).toContain("The draft changed since this suggestion");
});

it("blocks profile proposal application on servers without profile support", async () => {
  mocks.profiles = false;
  proposals([
    { type: "update-role", roleId: organization.directorRoleId, personality: "Calm" },
    { type: "set-mission", mission: "Build well" },
  ]);
  await render();
  expect(button("Apply all 2 to draft").disabled).toBe(true);
  const apply = Array.from(container.querySelectorAll("button")).filter(
    (entry) => entry.textContent === "Apply to draft",
  );
  expect(apply[0]?.disabled).toBe(true);
  expect(apply[1]?.disabled).toBe(false);
  await act(async () => apply[0]?.click());
  expect(props.onApplyBatch).not.toHaveBeenCalled();
});

it("keeps the current draft when restoring a failed historical message, then restores into an empty composer", async () => {
  const requestId = OrganizationArchitectMessageId.make("failed-request");
  query.data = {
    ...emptyHistory,
    messages: [
      {
        id: requestId,
        organizationId: organization.id,
        requestId,
        role: "user",
        text: "Earlier question",
        baseRevision: 1,
        modelSelection: null,
        createdAt: organization.createdAt,
      },
    ],
    requests: [
      {
        requestId,
        organizationId: organization.id,
        baseRevision: 1,
        status: "failed",
        failureMessage: "Provider unavailable",
        createdAt: organization.createdAt,
        updatedAt: organization.updatedAt,
      },
    ],
  };
  await render();
  await input("Keep my current draft");
  await click("Use message again");
  expect(composer().value).toBe("Keep my current draft");
  expect(element('[role="alert"]').textContent).toContain("Your current draft is kept");
  await input("");
  await click("Use message again");
  expect(composer().value).toBe("Earlier question");
  expect(mocks.send).not.toHaveBeenCalled();
});

it("previews complete updated profiles and an explicit field clear", async () => {
  const personality = "Ask thoughtful questions. ".repeat(25) + "Final personality instruction";
  const skills = "Trace every boundary. ".repeat(25) + "Final skills instruction";
  proposals([
    { type: "update-role", roleId: organization.directorRoleId, personality, focus: "", skills },
  ]);
  await render();
  const review = element<HTMLDetailsElement>('article[aria-label="Architect reply"] details');
  await act(async () => element("summary").click());
  expect(review.textContent).toContain(personality);
  expect(review.textContent).toContain("Areas of focus: Clear this field");
  expect(review.textContent).toContain(skills);
  expect(props.onApplyBatch).not.toHaveBeenCalled();
});

it("keeps the picker available to recover when the preferred provider has no models", async () => {
  mocks.emptyPreferredModels = true;
  await render();
  await input("Help design this team");
  expect(button("Send message to Architect").disabled).toBe(true);
  await click("Choose alternate provider");
  expect(button("Send message to Architect").disabled).toBe(false);
  await click("Send message to Architect");
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        modelSelection: { instanceId: "alternate", model: "model" },
      }),
    }),
  );
});
