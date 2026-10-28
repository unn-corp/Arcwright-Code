import { act, render as renderUi, type Screen } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const SearchTargetContext = createContext<string | null>(null);
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
  ThemeLibrary: ({
    isImportOpen,
    onImportOpenChange,
  }: {
    isImportOpen: boolean;
    onImportOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="theme-library">
      Library controls
      <button onClick={() => onImportOpenChange(!isImportOpen)}>
        {isImportOpen ? "Back to themes" : "Import theme"}
      </button>
    </div>
  ),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  useSettingsSearchTargetId: () => useContext(SearchTargetContext),
  SettingsSearchTarget: ({ id, children }: { id: string; children: ReactNode }) => (
    <div id={id}>{children}</div>
  ),
  SettingsSection: ({ id, children }: { id: string; children: ReactNode }) =>
    id === "typography" ? <section id={id} /> : <section id={id}>{children}</section>,
  SettingsRow: ({ id, control }: { id?: string; control?: ReactNode }) => (
    <div id={id}>{id === "panel-animations" ? control : null}</div>
  ),
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
const panel = () => (
  <SearchTargetContext value={state.hash || null}>
    <AppearanceSettingsPanel />
  </SearchTargetContext>
);
async function openLibrary(root: Screen) {
  const container = root.container;
  await root.rerender(panel());
  await act(() =>
    container.querySelector<HTMLButtonElement>('[data-testid="theme-library"] button')!.click(),
  );
  expect(hasTarget(root, "chat-width")).toBe(true);
  expect(container.textContent).toContain("Library controls");
}
describe("Appearance inline library search navigation", () => {
  it.each([
    "chat-width",
    "standard-thread-feed",
    "math-rendering",
    "setting-glass-opacity",
    "appearance-interface",
    "panel-animations",
    "motion",
    "typography",
  ])("keeps %s reachable while opening and closing theme import", async (target) => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await openLibrary(root);
    state.hash = target;
    await act(() => root.rerender(panel()));
    expect(hasTarget(root, target)).toBe(true);
    if (target === "motion") {
      expect(hasTarget(root, "panel-animations")).toBe(true);
      const duration = root.getByRole("slider", { name: "Panel animation duration" });
      await expect.element(duration).toBeVisible();
      await expect.element(duration).toHaveValue("0");
    }
    await act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="theme-library"] button')!.click(),
    );
    expect(hasTarget(root, "chat-width")).toBe(true);
    state.hash = "";
    await act(() => root.rerender(panel()));
    state.hash = target;
    await act(() => root.rerender(panel()));
    expect(hasTarget(root, target)).toBe(true);
  });
  it("preserves inline library controls for theme targets and Back to themes", async () => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await openLibrary(root);
    state.hash = "appearance";
    await act(() => root.rerender(panel()));
    expect(hasTarget(root, "chat-width")).toBe(true);
    await act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="theme-library"] button')!.click(),
    );
    expect(hasTarget(root, "chat-width")).toBe(true);
  });
});
