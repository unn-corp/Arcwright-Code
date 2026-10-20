import { act, render as renderUi, type Screen } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ hash: "" }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: <T,>({ select }: { select: (location: { hash: string }) => T }) =>
    select({ hash: state.hash }),
}));
vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({ theme: "system" }),
}));
vi.mock("../../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../SidebarStageBackdrop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../SidebarStageBackdrop")>()),
  useEnvironmentStageLabel: () => "Dev",
}));
vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./ThemeSettings", () => ({
  ThemeLibrary: ({ compact, onManage }: { compact: boolean; onManage: () => void }) =>
    compact ? <button onClick={onManage}>Manage themes</button> : <div>Library controls</div>,
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ id, children }: { id: string; children: ReactNode }) =>
    id === "typography" ? <section id={id} /> : <section id={id}>{children}</section>,
  SettingsRow: ({ id }: { id?: string }) => <div id={id} />,
}));
import { AppearanceSettingsPanel } from "./SettingsPanels";
async function setup() {
  state.hash = "";
  // Navigation is mocked; this fixture exercises only the panel or bridge.
  const root = await renderUi(null, { router: false });
  return {
    root,
    container: root.container,
    async [Symbol.asyncDispose]() {
      await root[Symbol.asyncDispose]();
      vi.unstubAllGlobals();
    },
  };
}

const hasTarget = (root: Screen, id: string) =>
  root.container.querySelector(`[id="${id}"]`) !== null;
async function openLibrary(root: Screen) {
  const container = root.container;
  await root.rerender(<AppearanceSettingsPanel />);
  await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(hasTarget(root, "chat-width")).toBe(false);
}
describe("Appearance library search navigation", () => {
  it.each([
    "chat-width",
    "standard-thread-feed",
    "math-rendering",
    "setting-glass-opacity",
    "appearance-interface",
    "panel-animations",
    "motion",
    "typography",
  ])("returns from Manage themes for %s and allows returning to the library", async (target) => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await openLibrary(root);
    state.hash = target;
    await act(() => root.rerender(<AppearanceSettingsPanel />));
    expect(hasTarget(root, target)).toBe(true);
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(hasTarget(root, "chat-width")).toBe(false);
    state.hash = "";
    await act(() => root.rerender(<AppearanceSettingsPanel />));
    state.hash = target;
    await act(() => root.rerender(<AppearanceSettingsPanel />));
    expect(hasTarget(root, target)).toBe(true);
  });
  it("preserves library controls for theme targets and the Back button", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await openLibrary(root);
    state.hash = "appearance";
    await act(() => root.rerender(<AppearanceSettingsPanel />));
    expect(hasTarget(root, "chat-width")).toBe(false);
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(hasTarget(root, "chat-width")).toBe(true);
  });
});
