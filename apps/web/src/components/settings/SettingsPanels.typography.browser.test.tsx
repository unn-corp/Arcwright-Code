import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, createContext, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SearchTargetContext = createContext<string | null>(null);
const state = vi.hoisted(() => ({ hash: "", updateSettings: vi.fn() }));
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
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock("./ThemeSettings", () => ({
  ThemeLibrary: ({ compact, onManage }: { compact: boolean; onManage: () => void }) =>
    compact ? <button onClick={onManage}>Manage themes</button> : <div>Library controls</div>,
}));
vi.mock("./FontFamilyPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./FontFamilyPicker")>()),
  useFontEnumeration: () => ({ status: "unsupported" }),
}));
vi.mock("./SettingsFontPreviews", () => ({
  CodeFontPreview: () => null,
  PromptFontPreview: () => null,
  TerminalFontPreview: () => null,
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  useSettingsSearchTargetId: () => useContext(SearchTargetContext),
  SettingsSection: ({
    id,
    children,
    headerAction,
  }: {
    id: string;
    children: ReactNode;
    headerAction?: ReactNode;
  }) =>
    id === "typography" ? (
      <section id={id}>
        {headerAction}
        {children}
      </section>
    ) : (
      <section id={id} />
    ),
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
  localStorage.clear();
  state.updateSettings.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const panel = () => (
  <SearchTargetContext value={state.hash || null}>
    <AppearanceSettingsPanel />
  </SearchTargetContext>
);
const hasTarget = (id: string) => container.querySelector(`[id="${id}"]`) !== null;
describe("Typography search navigation", () => {
  it.each(["prompt-font", "terminal-font"])(
    "reopens Advanced for repeated %s after clearing the search target",
    async (target) => {
      await act(() => {
        root.render(panel());
      });
      expect(hasTarget(target)).toBe(false);
      state.hash = target;
      await act(() => root.render(panel()));
      expect(hasTarget(target)).toBe(true);
      await act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Show advanced typography settings"]')!
          .click(),
      );
      expect(hasTarget(target)).toBe(false);
      state.hash = "";
      await act(() => root.render(panel()));
      state.hash = target;
      await act(() => root.render(panel()));
      expect(hasTarget(target)).toBe(true);
      expect(state.updateSettings).not.toHaveBeenCalled();
    },
  );
});
