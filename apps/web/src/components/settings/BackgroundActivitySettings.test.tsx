import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ hash: "", canWrite: true, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: <T,>({ select }: { select: (location: { hash: string; state: object }) => T }) =>
    select({ hash: state.hash, state: {} }),
  useNavigate: () => state.navigate,
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useScopedSettingsWriteAllowed: () => state.canWrite,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./SettingsSectionNavigation", () => ({ SettingsSectionNavigation: () => null }));
import { SettingsPageContainer } from "./settingsLayout";
import {
  BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS,
  BackgroundActivityAdvancedDialog,
  BackgroundActivitySearchOpener,
} from "./BackgroundActivitySettings";
import { settingsTargetDestination } from "./settingsSearch";

function Fixture({ enabled = true }: { enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsPageContainer>
      <BackgroundActivitySearchOpener enabled={enabled} onOpen={setOpen} />
      <BackgroundActivityAdvancedDialog open={open} onOpenChange={setOpen} />
    </SettingsPageContainer>
  );
}

afterEach(() => vi.unstubAllGlobals());

it.each([...BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS])(
  "opens and focuses %s, including repeated navigation after Done",
  async (target) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    HTMLElement.prototype.getAnimations = () => [];
    state.hash = target;
    state.canWrite = true;
    state.navigate.mockReset();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    state.navigate.mockImplementation(() => {
      state.hash = "";
      root.render(<Fixture />);
      return Promise.resolve();
    });
    try {
      expect(settingsTargetDestination(target)).toBe("/settings/general");
      await act(async () => root.render(<Fixture />));
      await vi.waitFor(() => expect(document.activeElement?.id).toBe(target));
      expect(scroll).toHaveBeenCalled();
      expect(state.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ hash: "", replace: true }),
      );
      state.hash = "";
      await act(async () => root.render(<Fixture />));
      const done = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Done",
      )!;
      await act(async () => done.click());
      state.hash = target;
      await act(async () => root.render(<Fixture />));
      await vi.waitFor(() => expect(document.activeElement?.id).toBe(target));
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
    }
  },
);

it.each([
  { enabled: false, canWrite: true },
  { enabled: true, canWrite: false },
])("respects scope enabled=$enabled and write access=$canWrite", async ({ enabled, canWrite }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.hash = "git-fetch-interval";
  state.canWrite = canWrite;
  state.navigate.mockReset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Fixture enabled={enabled} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById("git-fetch-interval")).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
