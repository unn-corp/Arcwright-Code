import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  hash: "",
  locationListeners: new Set<() => void>(),
  canWrite: true,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: <T,>({ select }: { select: (location: { hash: string; state: object }) => T }) => {
    const hash = useSyncExternalStore(
      (listener) => {
        state.locationListeners.add(listener);
        return () => state.locationListeners.delete(listener);
      },
      () => state.hash,
    );
    return select({ hash, state: {} });
  },
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

function setHash(hash: string) {
  state.hash = hash;
  for (const listener of state.locationListeners) listener();
}

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
      setHash("");
      return Promise.resolve();
    });
    try {
      expect(settingsTargetDestination(target)).toBe("/settings/maintenance");
      await act(async () => root.render(<Fixture />));
      await vi.waitFor(() => expect(document.activeElement?.id).toBe(target));
      expect(scroll).toHaveBeenCalled();
      expect(state.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ hash: "", replace: true }),
      );
      await act(async () => setHash(""));
      const done = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Done",
      )!;
      await act(async () => done.click());
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
      scroll.mockClear();
      await act(async () => setHash(target));
      await vi.waitFor(() => expect(document.activeElement?.id).toBe(target));
      expect(scroll).toHaveBeenCalled();
      expect(state.hash).toBe("");
      expect(state.navigate).toHaveBeenCalledTimes(2);
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
