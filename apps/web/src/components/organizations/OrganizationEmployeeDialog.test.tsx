// @vitest-environment jsdom
import {
  OrganizationId,
  OrganizationRoleId,
  ProviderInstanceId,
  type Organization,
  type OrganizationRole,
} from "@t3tools/contracts";
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

const role: OrganizationRole = {
  id: OrganizationRoleId.make("employee"),
  kind: "engineering",
  title: "Engineer",
  mandate: "Own implementation",
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

it("preserves unavailable model assignment and options exactly, and keeps content after a rejected save", async () => {
  await render();
  await click("Continue");
  await click("Continue");
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
  props = { ...props, supportsEmployeeConfiguration: false };
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
  await click("Continue");
  await click("Continue");
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
  expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
  await act(async () => resolveSave(true));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("allows a new employee to stay unassigned without adopting a configured provider", async () => {
  const { role: _role, ...createProps } = props;
  props = createProps;
  await render();
  expect(button("Continue").disabled).toBe(true);
  const input = document.querySelector("input");
  if (!input) throw new Error("Missing employee name");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "New engineer",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await review();
  await click("Save employee");
  const saved = vi.mocked(props.onSave).mock.calls[0]?.[0];
  expect(saved).toMatchObject({ title: "New engineer", kind: "engineering", poolSize: 1 });
  expect(saved?.id).not.toBe(role.id);
  expect(saved).not.toHaveProperty("modelSelection");
});
