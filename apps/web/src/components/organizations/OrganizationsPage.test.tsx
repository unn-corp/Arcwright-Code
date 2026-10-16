// @vitest-environment jsdom
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { OrganizationsPage } from "./OrganizationsPage";

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  navigate: vi.fn(),
  refresh: vi.fn(),
  offline: false,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocked.navigate,
  Link: ({ children }: { children: ReactNode }) => <a href="/organizations/draft">{children}</a>,
}));
vi.mock("../../state/organizations", () => ({
  organizationEnvironment: { create: "create", repositoryLoad: "load" },
  useOrganizations: () => ({
    environmentId: "environment",
    data: { organizations: [] },
    isSuccess: true,
    isPending: false,
    error: null,
    refresh: mocked.refresh,
  }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "environment",
  useEnvironments: () => ({ networkStatus: mocked.offline ? "offline" : "online" }),
}));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({ githubAccounts: {} }) }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "create" ? mocked.create : mocked.load),
}));
vi.mock("./OrganizationPageShell", () => ({
  OrganizationPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocked.offline = false;
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});
function button(name: string) {
  const element = Array.from(document.querySelectorAll("button")).find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name,
  );
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
}
async function fill(id: string, value: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing native input setter");
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("reveals a focused create form, preserves a cancelled draft, and navigates after saving", async () => {
  mocked.create.mockResolvedValue({ _tag: "Success", value: { id: "created-organization" } });
  await act(async () => root.render(<OrganizationsPage />));
  expect(document.querySelector("form")).toBeNull();
  await act(async () => button("New organization").click());
  expect(button("Create organization").disabled).toBe(true);
  await fill("organization-name", "  Product team  ");
  await act(async () => button("Cancel").click());
  expect(mocked.create).not.toHaveBeenCalled();
  await act(async () => button("New organization").click());
  expect(document.querySelector<HTMLInputElement>("#organization-name")?.value).toBe(
    "  Product team  ",
  );
  await act(async () => button("Create organization").click());
  expect(mocked.create).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "environment",
      input: expect.objectContaining({ title: "Product team", mission: "", actor: "user" }),
    }),
  );
  expect(mocked.refresh).toHaveBeenCalled();
  expect(mocked.navigate).toHaveBeenCalledWith({
    to: "/organizations/$organizationId",
    params: { organizationId: "created-organization" },
  });
});

it("keeps entered values and shows a failed save inside the creation dialog", async () => {
  mocked.create.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Name unavailable")),
  });
  await act(async () => root.render(<OrganizationsPage />));
  await act(async () => button("New organization").click());
  await fill("organization-name", "Design team");
  await act(async () => button("Create organization").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Organization wasn’t created",
  );
  expect(document.querySelector<HTMLInputElement>("#organization-name")?.value).toBe("Design team");
  expect(mocked.navigate).not.toHaveBeenCalled();
});

it("retains repository sync and public-exposure choices when importing", async () => {
  mocked.load.mockResolvedValue({
    _tag: "Success",
    value: { organizationId: "imported-organization" },
  });
  await act(async () => root.render(<OrganizationsPage />));
  await act(async () => button("Import from GitHub").click());
  await fill("organization-repository-load", "owner/team");
  const checkboxes = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'));
  expect(checkboxes).toHaveLength(2);
  await act(async () => {
    checkboxes[0]!.click();
    checkboxes[1]!.click();
  });
  await act(async () => button("Import organization").click());
  expect(mocked.load).toHaveBeenCalledWith({
    environmentId: "environment",
    input: { repository: "owner/team", autoSync: false, publicExposureAcknowledged: true },
  });
  expect(mocked.navigate).toHaveBeenCalledWith({
    to: "/organizations/$organizationId",
    params: { organizationId: "imported-organization" },
  });
});

it("blocks creation and import while offline", async () => {
  mocked.offline = true;
  await act(async () => root.render(<OrganizationsPage />));
  expect(button("New organization").disabled).toBe(true);
  expect(button("Import from GitHub").disabled).toBe(true);
  expect(document.body.textContent).toContain("You’re offline");
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.load).not.toHaveBeenCalled();
});
