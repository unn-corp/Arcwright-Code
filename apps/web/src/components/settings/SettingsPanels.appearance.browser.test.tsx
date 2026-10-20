import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  state.hash = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const hasTarget = (id: string) => container.querySelector(`[id="${id}"]`) !== null;
async function openLibrary() {
  await act(() => {
    root.render(<AppearanceSettingsPanel />);
  });
  await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(hasTarget("chat-width")).toBe(false);
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
    await openLibrary();
    state.hash = target;
    await act(() => root.render(<AppearanceSettingsPanel />));
    expect(hasTarget(target)).toBe(true);
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(hasTarget("chat-width")).toBe(false);
    state.hash = "";
    await act(() => root.render(<AppearanceSettingsPanel />));
    state.hash = target;
    await act(() => root.render(<AppearanceSettingsPanel />));
    expect(hasTarget(target)).toBe(true);
  });
  it("preserves library controls for theme targets and the Back button", async () => {
    await openLibrary();
    state.hash = "appearance";
    await act(() => root.render(<AppearanceSettingsPanel />));
    expect(hasTarget("chat-width")).toBe(false);
    await act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(hasTarget("chat-width")).toBe(true);
  });
});
