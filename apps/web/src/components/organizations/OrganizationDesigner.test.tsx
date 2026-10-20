import { OrganizationId, OrganizationRoleId, type Organization } from "@t3tools/contracts";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { OrganizationDesigner } from "./OrganizationDesigner";

const server = vi.hoisted(() => ({ employeeConfiguration: true, employeeProfiles: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? {
          environment: {
            capabilities: {
              organizationEmployeeConfiguration: server.employeeConfiguration,
              organizationEmployeeProfiles: server.employeeProfiles,
            },
          },
        }
      : [],
}));
vi.mock("../../state/server", () => ({
  primaryServerConfigAtom: "config",
  primaryServerProvidersAtom: "providers",
}));
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

const director = OrganizationRoleId.make("director");
const engineer = OrganizationRoleId.make("engineer");
const organization: Organization = {
  id: OrganizationId.make("team"),
  title: "Team",
  mission: "Build",
  lifecycle: "draft",
  draftRevision: 1,
  publishedRevision: null,
  architectRoleId: OrganizationRoleId.make("architect"),
  directorRoleId: director,
  graph: {
    roles: [
      { id: director, kind: "director", title: "Director", mandate: "Lead", poolSize: 1 },
      { id: engineer, kind: "engineering", title: "Engineer", mandate: "Build", poolSize: 1 },
    ],
    edges: [],
  },
  workflows: [],
  layout: { positions: [] },
  bindings: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof OrganizationDesigner>;
beforeEach(() => {
  server.employeeConfiguration = true;
  server.employeeProfiles = true;
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
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = { organization, busy: false, onChange: vi.fn(async () => true) };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<OrganizationDesigner {...props} />));
}
function element<T extends Element = HTMLElement>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function button(name: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function input(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, text: string) {
  const trigger = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="combobox"]'),
  ).find((entry) => {
    const labelId = entry.getAttribute("aria-labelledby");
    return (
      entry.getAttribute("aria-label") === label ||
      (labelId && document.getElementById(labelId)?.textContent === label)
    );
  });
  if (!trigger) throw new Error(`Missing picker ${label}`);
  await act(async () => trigger.click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (entry) => entry.textContent === text,
  );
  if (!option) throw new Error(`Missing option ${text}`);
  await act(async () => option.click());
}
async function addHere() {
  const frame = element('[aria-label="Organization role graph"]');
  await act(async () =>
    frame.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 600,
        clientY: 400,
      }),
    ),
  );
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (entry) => entry.textContent === "Add employee here",
  );
  if (!item) throw new Error("Missing Add employee here");
  await act(async () => item.click());
}

it("starts with the graph and keeps an Architect draft and model selection across close/reopen", async () => {
  function Assistant() {
    const [draft, setDraft] = useState("");
    const [model, setModel] = useState("default");
    return (
      <div>
        <textarea
          aria-label="Architect draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button onClick={() => setModel("chosen-model")}>Choose assistant model</button>
        <output aria-label="Assistant model">{model}</output>
      </div>
    );
  }
  props = { ...props, assistant: <Assistant /> };
  await render();
  expect(element('[aria-label="Organization role graph"]')).toBeTruthy();
  expect(element<HTMLElement>('aside[aria-label="Architect assistant"]').hidden).toBe(true);
  await click("Architect");
  await input(element<HTMLTextAreaElement>('[aria-label="Architect draft"]'), "Unsent design idea");
  await click("Choose assistant model");
  await click("Focus chat");
  expect(element('[aria-label="Organization role graph"]').closest("section")?.hidden).toBe(true);
  expect(element<HTMLTextAreaElement>('[aria-label="Architect draft"]').value).toBe(
    "Unsent design idea",
  );
  await click("Show graph");
  expect(element('[aria-label="Organization role graph"]').closest("section")?.hidden).toBe(false);
  await click("Close Architect");
  expect(element<HTMLElement>('aside[aria-label="Architect assistant"]').hidden).toBe(true);
  await click("Architect");
  expect(element<HTMLElement>('aside[aria-label="Architect assistant"]').hidden).toBe(false);
  expect(element<HTMLTextAreaElement>('[aria-label="Architect draft"]').value).toBe(
    "Unsent design idea",
  );
  expect(element('[aria-label="Assistant model"]').textContent).toBe("chosen-model");
});

it("adds the first employee with provider/model and graph position in a single change", async () => {
  props = { ...props, organization: { ...organization, graph: { roles: [], edges: [] } } };
  await render();
  expect(document.querySelector("aside")).toBeNull();
  await addHere();
  await input(element<HTMLInputElement>('[role="dialog"] input'), "First engineer");
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await choose("Provider", "Codex");
  await choose("Model", "Configured model");
  await click("Continue");
  await click("Save employee");
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(props.onChange).toHaveBeenCalledWith({
    type: "add-role",
    role: expect.objectContaining({
      title: "First engineer",
      modelSelection: { instanceId: "codex", model: "configured-model" },
    }),
    position: { x: 320, y: 206 },
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("omits position and optional model configuration when adding on an old server", async () => {
  server.employeeConfiguration = false;
  props = { ...props, organization: { ...organization, graph: { roles: [], edges: [] } } };
  await render();
  await addHere();
  await input(element<HTMLInputElement>('[role="dialog"] input'), "Legacy engineer");
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Save employee");
  expect(props.onChange).toHaveBeenCalledTimes(1);
  const change = vi.mocked(props.onChange).mock.calls[0]?.[0];
  expect(change?.type).toBe("add-role");
  expect(change).not.toHaveProperty("position");
  if (change?.type !== "add-role") throw new Error("Expected add-role");
  expect(change.role).not.toHaveProperty("modelSelection");
  expect(change.role.title).toBe("Legacy engineer");
});

it("connects two distinct employees through touch-friendly controls with the correct direction", async () => {
  await render();
  await click("Team list");
  await click("Engineer");
  await click("Connect");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Engineer");
  await click("Engineer");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("Director");
  expect(element('[role="dialog"]').textContent).toContain("Employee relationships");
  expect(element('[aria-label="Employee"]').textContent).toContain("Engineer");
  expect(element('[aria-label="Connected employee"]').textContent).toContain("Director");
  await click("Add relationship");
  expect(props.onChange).toHaveBeenCalledWith({
    type: "add-edge",
    edge: { id: expect.any(String), fromRoleId: engineer, toRoleId: director, kind: "reports-to" },
  });
});

it("blocks employee and relationship mutations while busy, including an already-open dialog", async () => {
  await render();
  await click("Relationships");
  props = { ...props, busy: true };
  await render();
  expect(button("Add employee").disabled).toBe(true);
  expect(button("Relationships").disabled).toBe(true);
  expect(button("Connect").disabled).toBe(true);
  expect(button("Edit employee").disabled).toBe(true);
  expect(button("Add relationship").disabled).toBe(true);
  expect(button("Done").disabled).toBe(true);
  await click("Add relationship");
  await act(async () =>
    element("form#organization-relationship-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(props.onChange).not.toHaveBeenCalled();
});

it("uses friendly relationship choices and prevents self-connections and duplicate edges", async () => {
  await render();
  await click("Relationships");
  await choose("Connected employee", "Director");
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Choose two different employees.",
  );
  expect(button("Add relationship").disabled).toBe(true);
  await choose("Connected employee", "Engineer");
  await choose("Relationship", "Reviews work from");
  expect(document.body.textContent).toContain(
    "The first employee reviews the second employee’s work.",
  );
  await click("Add relationship");
  expect(props.onChange).toHaveBeenCalledWith({
    type: "add-edge",
    edge: { id: expect.any(String), fromRoleId: director, toRoleId: engineer, kind: "reviews" },
  });
  const saved = vi.mocked(props.onChange).mock.calls[0]?.[0];
  if (saved?.type !== "add-edge") throw new Error("Expected add-edge");
  props = {
    ...props,
    organization: {
      ...organization,
      draftRevision: 2,
      graph: { ...organization.graph, edges: [saved.edge] },
    },
  };
  await render();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "This relationship already exists.",
  );
  expect(button("Add relationship").disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("reviews work from");
});

it("prevents repeated relationship submissions and closing while a save is pending, then allows retry", async () => {
  let settle: (value: boolean) => void = () => {};
  props = {
    ...props,
    onChange: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    ),
  };
  await render();
  await click("Relationships");
  await act(async () => {
    const form = element("form#organization-relationship-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(button("Done").disabled).toBe(true);
  expect(button("Saving…").disabled).toBe(true);
  expect(element<HTMLButtonElement>('[aria-label="Relationship"]').disabled).toBe(true);
  expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
  await act(async () => settle(false));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
  expect(button("Add relationship").disabled).toBe(false);
  expect(element('[aria-label="Employee"]').textContent).toContain("Director");
  expect(element('[aria-label="Connected employee"]').textContent).toContain("Engineer");
  await click("Add relationship");
  expect(props.onChange).toHaveBeenCalledTimes(2);
  await act(async () => settle(true));
});

it("omits existing profile fields from legacy-server edits without altering the current role", async () => {
  server.employeeProfiles = false;
  const role = {
    ...organization.graph.roles[0]!,
    personality: "Calm",
    focus: "Reliability",
    skills: "Review failures",
  };
  props = {
    ...props,
    organization: { ...organization, graph: { ...organization.graph, roles: [role] } },
  };
  await render();
  await click("Edit employee");
  await input(element<HTMLInputElement>('[role="dialog"] input'), "Renamed director");
  await click("Continue");
  await click("Continue");
  for (const field of Array.from(
    document.querySelectorAll<HTMLTextAreaElement>('[role="dialog"] textarea'),
  ))
    expect(field.disabled).toBe(true);
  await click("Continue");
  await click("Continue");
  await click("Save employee");
  const change = vi.mocked(props.onChange).mock.calls[0]?.[0];
  expect(change).toMatchObject({
    type: "update-role",
    roleId: director,
    title: "Renamed director",
  });
  expect(change).not.toHaveProperty("personality");
  expect(change).not.toHaveProperty("focus");
  expect(change).not.toHaveProperty("skills");
  expect(props.organization.graph.roles[0]).toMatchObject({
    personality: "Calm",
    focus: "Reliability",
    skills: "Review failures",
  });
});

it("sends all edited profile fields, including an explicit clear, in one employee update", async () => {
  const role = {
    ...organization.graph.roles[0]!,
    personality: "Calm",
    focus: "Reliability",
    skills: "Review failures",
  };
  props = {
    ...props,
    organization: { ...organization, graph: { ...organization.graph, roles: [role] } },
  };
  await render();
  await click("Edit employee");
  await click("Continue");
  await click("Continue");
  await input(element<HTMLTextAreaElement>('textarea[id$="-personality"]'), "Direct and curious");
  await input(element<HTMLTextAreaElement>('textarea[id$="-focus"]'), "");
  await input(element<HTMLTextAreaElement>('textarea[id$="-skills"]'), "Trace failure paths");
  await click("Continue");
  await click("Continue");
  await click("Save employee");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "update-role",
      roleId: director,
      personality: "Direct and curious",
      focus: "",
      skills: "Trace failure paths",
    }),
  );
});
