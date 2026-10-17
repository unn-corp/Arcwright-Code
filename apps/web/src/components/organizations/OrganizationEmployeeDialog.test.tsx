// @vitest-environment jsdom
import {
  OrganizationId,
  OrganizationRoleId,
  ProviderInstanceId,
  type Organization,
  OrganizationRole,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  OrganizationEmployeeDialog,
  type OrganizationEmployeeDialogProps,
} from "./OrganizationEmployeeDialog";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({}) }));
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
    },
  ],
}));
vi.mock("../../modelSelection", () => ({
  getAppModelOptionsForInstance: () => [{ slug: "configured-model", name: "Configured model" }],
}));

const decodeRole = Schema.decodeUnknownSync(OrganizationRole);

const role: OrganizationRole = {
  id: OrganizationRoleId.make("employee"),
  kind: "engineering",
  title: "Engineer",
  mandate: "Own implementation",
  personality: "Explain decisions clearly",
  focus: "Reliable interfaces",
  skills: "Trace failure paths",
  poolSize: 1,
  modelSelection: {
    instanceId: ProviderInstanceId.make("missing-provider"),
    model: "saved-model",
    options: [{ id: "reasoning_effort", value: "high" }],
  },
};
const organization: Organization = {
  id: OrganizationId.make("organization"),
  title: "Team",
  mission: "Build",
  lifecycle: "draft",
  draftRevision: 1,
  publishedRevision: null,
  architectRoleId: OrganizationRoleId.make("architect"),
  directorRoleId: OrganizationRoleId.make("director"),
  graph: { roles: [role], edges: [] },
  workflows: [],
  layout: { positions: [] },
  bindings: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
let props: OrganizationEmployeeDialogProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    organization,
    role,
    busy: false,
    supportsEmployeeConfiguration: true,
    supportsEmployeeProfiles: true,
    onSave: vi.fn(async () => false),
    onClose: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<OrganizationEmployeeDialog {...props} />));
}
function button(name: string) {
  const found = Array.from(document.querySelectorAll("button")).find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function review() {
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Continue");
}
async function choose(label: string, text: string) {
  const trigger = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
  ).find((entry) => {
    const labelId = entry.getAttribute("aria-labelledby");
    return labelId && document.getElementById(labelId)?.textContent === label;
  });
  if (!trigger) throw new Error(`Missing picker: ${label}`);
  await act(async () => trigger.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (entry) => entry.textContent === text,
  );
  if (!option) throw new Error(`Missing option: ${text}`);
  await act(async () => option.click());
}

function field(label: string) {
  const element = Array.from(document.querySelectorAll("label")).find(
    (entry) => entry.textContent?.trim() === label,
  );
  const control = element?.control;
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing text field: ${label}`);
  }
  return control;
}
async function enter(label: string, value: string) {
  const control = field(label);
  await act(async () => {
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("preserves unavailable model assignment and options exactly, and keeps content after a rejected save", async () => {
  await render();
  await click("AI provider and model");
  expect(document.body.textContent).toContain("saved assignment is unavailable");
  await click("Continue");
  await click("Save employee");
  expect(props.onSave).toHaveBeenCalledWith(role);
  expect(vi.mocked(props.onSave).mock.calls[0]?.[0].modelSelection).toBe(role.modelSelection);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Your entries are still here",
  );
  expect(document.body.textContent).toContain("Own implementation");
});

it("blocks a changed draft without resetting the employee's entries", async () => {
  await render();
  await review();
  props = { ...props, organization: { ...organization, draftRevision: 2 } };
  await render();
  expect(button("Save employee").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Close and reopen");
  await click("Save employee");
  expect(props.onSave).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Own implementation");
});

it("omits AI configuration for old servers while preserving the other role fields", async () => {
  props = { ...props, supportsEmployeeConfiguration: false, supportsEmployeeProfiles: false };
  await render();
  await review();
  await click("Save employee");
  const saved = vi.mocked(props.onSave).mock.calls[0]?.[0];
  expect(saved).toEqual({
    id: role.id,
    kind: role.kind,
    title: role.title,
    mandate: role.mandate,
    poolSize: role.poolSize,
  });
  expect(saved).not.toHaveProperty("modelSelection");
});

it("requires an explicit model after a provider change and permits Set up later", async () => {
  await render();
  await click("AI provider and model");
  await choose("Provider", "Codex");
  expect(button("Continue").disabled).toBe(true);
  await choose("Model", "Configured model");
  expect(button("Continue").disabled).toBe(false);
  await click("Continue");
  await click("Save employee");
  expect(props.onSave).toHaveBeenLastCalledWith(
    expect.objectContaining({ modelSelection: { instanceId: "codex", model: "configured-model" } }),
  );
  await click("Back");
  await choose("Provider", "Set up later");
  await click("Continue");
  await click("Save employee");
  expect(props.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ modelSelection: null }));
});

it("guards duplicate saves and locks closing and Back until the save settles", async () => {
  let resolveSave: (saved: boolean) => void = () => {};
  props = {
    ...props,
    onSave: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSave = resolve;
        }),
    ),
  };
  await render();
  await review();
  await act(async () => {
    button("Save employee").click();
    button("Save employee").click();
  });
  expect(props.onSave).toHaveBeenCalledTimes(1);
  expect(button("Back").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(button("Profile").disabled).toBe(true);
  expect(button("Identity").disabled).toBe(true);
  expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
  await act(async () => resolveSave(true));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("allows a new employee to stay unassigned without adopting a configured provider", async () => {
  const { role: _role, ...createProps } = props;
  props = createProps;
  await render();
  expect(button("Continue").disabled).toBe(true);
  expect(button("Profile").disabled).toBe(true);
  await enter("Employee name", "New engineer");
  await review();
  await click("Save employee");
  const saved = vi.mocked(props.onSave).mock.calls[0]?.[0];
  expect(saved).toMatchObject({ title: "New engineer", kind: "engineering", poolSize: 1 });
  expect(saved?.id).not.toBe(role.id);
  expect(saved).not.toHaveProperty("modelSelection");
  expect(saved).toMatchObject({ personality: "", focus: "", skills: "" });
});

it("guides creation through an optional profile with labels, limits, counters, and review", async () => {
  const { role: _role, ...createProps } = props;
  props = createProps;
  await render();
  await enter("Employee name", "Release reviewer");
  await click("Continue");
  await enter("Responsibilities", "Review release readiness");
  await click("Continue");
  expect(document.body.textContent).toContain("Profile (step 3 of 5)");
  expect(button("Review").disabled).toBe(true);
  expect(document.body.textContent).toContain("do not install skills or grant tool access");
  for (const [label, limit] of [
    ["Personality", 2000],
    ["Areas of focus", 2000],
    ["Skills", 4000],
  ] as const) {
    expect(field(label)).toBeInstanceOf(HTMLTextAreaElement);
    expect(field(label).maxLength).toBe(limit);
    expect(field(label).getAttribute("aria-describedby")).toBeTruthy();
  }
  const personality = "Write concisely.\nExplain tradeoffs.";
  const focus = "Accessibility and reliability";
  const skills = "Before release, trace failure paths.";
  await enter("Personality", personality);
  await enter("Areas of focus", focus);
  await enter("Skills", skills);
  expect(document.body.textContent).toContain(`${personality.length} / 2000 characters`);
  await click("Continue");
  await click("Continue");
  expect(document.body.textContent).toContain(personality);
  expect(document.body.textContent).toContain(focus);
  expect(document.body.textContent).toContain(skills);
  await click("Save employee");
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Release reviewer",
      mandate: "Review release readiness",
      personality,
      focus,
      skills,
    }),
  );
  const saved = vi.mocked(props.onSave).mock.calls[0]?.[0];
  expect(decodeRole(saved)).toEqual(saved);
});

it("edits profiles directly, preserves unrelated fields and options, and allows clearing", async () => {
  await render();
  await click("Profile");
  expect(field("Personality").value).toBe(role.personality);
  expect(field("Areas of focus").value).toBe(role.focus);
  expect(field("Skills").value).toBe(role.skills);
  await enter("Personality", "Ask about tradeoffs");
  await enter("Areas of focus", "Security reviews");
  await enter("Skills", "Inspect authorization paths");
  await click("Review");
  await click("Save employee");
  expect(props.onSave).toHaveBeenLastCalledWith({
    ...role,
    personality: "Ask about tradeoffs",
    focus: "Security reviews",
    skills: "Inspect authorization paths",
  });
  expect(vi.mocked(props.onSave).mock.calls[0]?.[0].modelSelection).toBe(role.modelSelection);
  await click("Profile");
  expect(field("Personality").value).toBe("Ask about tradeoffs");
  expect(field("Areas of focus").value).toBe("Security reviews");
  expect(field("Skills").value).toBe("Inspect authorization paths");
  await enter("Personality", "");
  await enter("Areas of focus", "");
  await enter("Skills", "");
  await click("Review");
  await click("Save employee");
  expect(props.onSave).toHaveBeenLastCalledWith({
    ...role,
    personality: "",
    focus: "",
    skills: "",
  });
});

it("retains authored profile text when the draft becomes stale and locks navigation", async () => {
  await render();
  await click("Profile");
  await enter("Personality", "Stay concise");
  await enter("Areas of focus", "Runtime safety");
  await enter("Skills", "Trace permissions");
  props = { ...props, organization: { ...organization, draftRevision: 2 } };
  await render();
  expect(field("Personality").value).toBe("Stay concise");
  expect(field("Areas of focus").value).toBe("Runtime safety");
  expect(field("Skills").value).toBe("Trace permissions");
  expect(field("Skills").closest("fieldset")?.disabled).toBe(true);
  for (const label of [
    "Identity",
    "Responsibilities",
    "Profile",
    "AI provider and model",
    "Review",
    "Back",
    "Continue",
  ]) {
    expect(button(label).disabled).toBe(true);
  }
  expect(props.onSave).not.toHaveBeenCalled();
});

it("makes profiles inert on old servers and omits them independently of AI configuration", async () => {
  props = { ...props, supportsEmployeeProfiles: false };
  await render();
  await click("Profile");
  expect(document.body.textContent).toContain("Profile fields are read-only");
  for (const label of ["Personality", "Areas of focus", "Skills"]) {
    expect(field(label).disabled).toBe(true);
  }
  await click("Review");
  expect(document.body.textContent).toContain("Profile fields will not be sent");
  await click("Save employee");
  const { personality: _personality, focus: _focus, skills: _skills, ...expected } = role;
  expect(props.onSave).toHaveBeenCalledWith(expected);
});

it("blocks forward shortcuts until identity, capacity, and changed AI selection are valid", async () => {
  await render();
  await enter("Employee name", " ");
  expect(button("Review").disabled).toBe(true);
  expect(button("Profile").disabled).toBe(true);
  await enter("Employee name", "Engineer");
  await click("Responsibilities");
  await enter("Pool size", "0");
  expect(button("Profile").disabled).toBe(true);
  expect(button("Review").disabled).toBe(true);
  await enter("Pool size", "2");
  await click("AI provider and model");
  await choose("Provider", "Codex");
  expect(button("Review").disabled).toBe(true);
  await click("Profile");
  expect(button("Review").disabled).toBe(true);
  await click("AI provider and model");
  await choose("Model", "Configured model");
  await click("Review");
  await click("Save employee");
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ poolSize: 2 }));
});

it("blocks an over-limit profile without truncating existing authored text", async () => {
  props = { ...props, role: { ...role, skills: "s".repeat(4001) } };
  await render();
  await click("Profile");
  expect(field("Skills").value).toHaveLength(4001);
  expect(field("Skills").getAttribute("aria-invalid")).toBe("true");
  expect(button("Continue").disabled).toBe(true);
  expect(button("Review").disabled).toBe(true);
  await enter("Skills", "s".repeat(4000));
  await click("Review");
  await click("Save employee");
  expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({ skills: "s".repeat(4000) }));
});

it("retains every profile field after a thrown save and saves profiles without AI capability", async () => {
  props = {
    ...props,
    supportsEmployeeConfiguration: false,
    onSave: vi.fn(async () => {
      throw new Error("Connection lost");
    }),
  };
  await render();
  await click("Profile");
  await enter("Personality", "Explain uncertainty");
  await enter("Areas of focus", "Reliable releases");
  await enter("Skills", "Review failure paths");
  await click("Review");
  await click("Save employee");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(props.onClose).not.toHaveBeenCalled();
  const saved = vi.mocked(props.onSave).mock.calls[0]?.[0];
  expect(saved).toMatchObject({
    personality: "Explain uncertainty",
    focus: "Reliable releases",
    skills: "Review failure paths",
  });
  expect(saved).not.toHaveProperty("modelSelection");
  await click("Profile");
  expect(field("Personality").value).toBe("Explain uncertainty");
  expect(field("Areas of focus").value).toBe("Reliable releases");
  expect(field("Skills").value).toBe("Review failure paths");
});
