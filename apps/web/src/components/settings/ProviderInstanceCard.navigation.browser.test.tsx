import { act, render as renderUi } from "../../../test/render";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useSyncExternalStore, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  target: null as string | null,
  listeners: new Set<() => void>(),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  useSettingsSearchTargetId: () =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      },
      () => state.target,
    ),
  useSettingsSearchTarget: () => undefined,
  SettingsSection: ({ id, children }: { id: string; children: ReactNode }) => (
    <section id={id}>{children}</section>
  ),
  SettingsRow: () => null,
}));
vi.mock("./ProviderModelsSection", () => ({ ProviderModelsSection: () => null }));
import { ProviderInstanceCard } from "./ProviderInstanceCard";

const noop = () => undefined;
const props = {
  instanceId: ProviderInstanceId.make("codex_work"),
  instance: { driver: ProviderDriverKind.make("codex"), config: { setupMode: "managed" } },
  driverOption: undefined,
  liveProvider: undefined,
  mode: "editor" as const,
  runtime: <div>Managed runtime controls</div>,
  onUpdate: noop,
  hiddenModels: [],
  favoriteModels: [],
  modelOrder: [],
  onHiddenModelsChange: noop,
  onFavoriteModelsChange: noop,
  onToggleFavorite: noop,
  onModelOrderChange: noop,
};
async function setup() {
  state.target = null;
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

it.each(["runtime", "environment", "advanced"])(
  "reveals managed Codex %s targets inside Advanced",
  async (suffix) => {
    await using _fixture = await setup();
    const { root, container } = _fixture;
    await act(async () => root.rerender(<ProviderInstanceCard {...props} />));
    expect(container.querySelector("#provider-instance-codex_work-runtime")).toBeNull();
    await act(async () => {
      state.target = `provider-instance-codex_work-${suffix}`;
      state.listeners.forEach((listener) => listener());
    });
    const sections = Array.from(container.querySelectorAll("section"), (node) => node.id);
    expect(sections).toContain("provider-instance-codex_work-runtime");
    expect(sections).toContain("provider-instance-codex_work-environment");
    expect(container.textContent).toContain("Managed runtime controls");
  },
);
