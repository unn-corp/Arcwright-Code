import type { ComponentProps } from "react";
import { render as renderUi } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS } from "./BackgroundActivitySettings";

const state = vi.hoisted(() => ({ hash: "", environmentIds: ["one", "two"] }));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useLocation: (({ select }: { select: (location: { hash: string }) => unknown }) =>
    select({ hash: state.hash })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: state.environmentIds },
    connectedEnvironments: [],
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));
vi.mock(import("./SettingsScopeNotice"), () => ({
  SettingsScopeNotice: ({
    children,
    targetId,
  }: ComponentProps<typeof import("./SettingsScopeNotice").SettingsScopeNotice>) => (
    <section data-target-id={targetId}>{children}</section>
  ),
}));
import { SettingsScopeBoundary } from "../../routes/settings";

it.each([...BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS])(
  "keeps %s reachable by asking for one computer before rendering its settings",
  async (target) => {
    state.hash = `#${target}`;
    state.environmentIds = ["one", "two"];
    await using screen = await renderUi(null, { router: false });
    const container = screen.container;
    const render = () =>
      screen.rerender(
        <SettingsScopeBoundary pathname="/settings/general">
          <p>Settings destination</p>
        </SettingsScopeBoundary>,
      );
    await render();
    expect(container.textContent).toContain("Choose one computer");
    expect(container.textContent).not.toContain("Settings destination");
    expect(container.querySelector("section")?.getAttribute("data-target-id")).toBe(`#${target}`);
    state.environmentIds = ["one"];
    await render();
    expect(container.textContent).toBe("Settings destination");
  },
);
