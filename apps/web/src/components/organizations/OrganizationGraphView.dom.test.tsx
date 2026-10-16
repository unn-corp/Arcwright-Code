// @vitest-environment jsdom
import { OrganizationId, OrganizationRoleId, type Organization } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { OrganizationGraphView } from "./OrganizationGraphView";

const engineer = OrganizationRoleId.make("engineer");
const organization: Organization = {
  id: OrganizationId.make("team"),
  title: "Team",
  mission: "Build",
  lifecycle: "draft",
  draftRevision: 1,
  publishedRevision: null,
  architectRoleId: OrganizationRoleId.make("architect"),
  directorRoleId: engineer,
  graph: {
    roles: [
      { id: engineer, kind: "engineering", title: "Engineer", mandate: "Build", poolSize: 1 },
    ],
    edges: [],
  },
  workflows: [],
  layout: { positions: [{ roleId: engineer, x: 100, y: 80 }] },
  bindings: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof OrganizationGraphView>;
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
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 50,
    y: 30,
    left: 50,
    top: 30,
    right: 850,
    bottom: 530,
    width: 800,
    height: 500,
    toJSON() {},
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  props = {
    organization,
    selectedRoleId: null,
    search: "",
    busy: false,
    onSelectRole: vi.fn(),
    onMoveRole: vi.fn(async () => true),
    onAddEmployee: vi.fn(),
    onEditEmployee: vi.fn(),
    onConnectEmployee: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<OrganizationGraphView {...props} />));
}
function element<T extends Element = HTMLElement>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
async function context(target: Element) {
  await act(async () =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 650,
        clientY: 430,
      }),
    ),
  );
}
function item(text: string) {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (entry) => entry.textContent === text,
  );
  if (!found) throw new Error(`Missing menu item ${text}`);
  return found;
}
async function key(target: Element, key: string, shiftKey = false) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey }),
    ),
  );
}

it("right-clicks empty graph space through the real menu and adds at the panned, zoomed world point", async () => {
  props = { ...props, organization: { ...organization, graph: { roles: [], edges: [] } } };
  await render();
  const frame = element('[aria-label="Organization role graph"]');
  // Empty graph fits at (280, 194), then keyboard zoom centers at (400, 250).
  await key(frame, "+");
  await key(frame, "ArrowRight");
  await context(frame);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Connect to another employee");
  await act(async () => item("Add employee here").click());
  // Viewport is (216, 182.8), zoom 1.2; local pointer is (600, 400).
  expect(props.onAddEmployee).toHaveBeenCalledExactlyOnceWith({ x: 320, y: 181 });
});

it.each(["Edit employee", "Connect to another employee"])(
  "uses the node context for %s instead of the blank-space menu",
  async (action) => {
    await render();
    // Target the nested title span, as a real right-click on the card would.
    await context(element('[aria-label="Select Engineer"] span'));
    expect(
      Array.from(document.querySelectorAll('[role="menuitem"]')).some(
        (entry) => entry.textContent === "Add employee here",
      ),
    ).toBe(false);
    await act(async () => item(action).click());
    expect(
      action === "Edit employee" ? props.onEditEmployee : props.onConnectEmployee,
    ).toHaveBeenCalledExactlyOnceWith(engineer);
    expect(props.onAddEmployee).not.toHaveBeenCalled();
  },
);

it("supports card selection, double-click edit, and keyboard movement without a context menu", async () => {
  await render();
  const card = element<HTMLButtonElement>('[aria-label="Select Engineer"]');
  await act(async () => card.click());
  expect(props.onSelectRole).toHaveBeenCalledWith(engineer);
  await act(async () => card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(props.onEditEmployee).toHaveBeenCalledWith(engineer);
  await key(element('[aria-label^="Move Engineer"]'), "ArrowRight", true);
  expect(props.onMoveRole).toHaveBeenCalledExactlyOnceWith(engineer, { x: 140, y: 80 });
});

it("disables context mutations and movement while busy but keeps fit available", async () => {
  props = { ...props, busy: true };
  await render();
  await context(element('[aria-label="Select Engineer"]'));
  expect(item("Edit employee").getAttribute("aria-disabled")).toBe("true");
  expect(item("Connect to another employee").getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    item("Edit employee").click();
    item("Connect to another employee").click();
  });
  expect(props.onEditEmployee).not.toHaveBeenCalled();
  expect(props.onConnectEmployee).not.toHaveBeenCalled();
  expect(element<HTMLButtonElement>('[aria-label^="Move Engineer"]').disabled).toBe(true);
  expect(item("Fit team to view").getAttribute("aria-disabled")).not.toBe("true");
});
