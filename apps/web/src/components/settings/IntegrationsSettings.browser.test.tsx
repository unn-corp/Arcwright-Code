import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { StrictMode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { BrowserSettingsPanel, DevicesSettingsPanel } from "./IntegrationsSettings";

const { listBrowserImportSources } = vi.hoisted(() => ({
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock(import("../preview/previewBridge"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewBridge: { ...actual.previewBridge, listBrowserImportSources } as never,
  };
});
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));

function setup() {
  listBrowserImportSources.mockClear();
}

async function openSettings(page: "browser" | "devices" = "browser") {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <StrictMode>
        {page === "browser" ? <BrowserSettingsPanel /> : <DevicesSettingsPanel />}
      </StrictMode>,
    ),
  );
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector(
        page === "browser" ? "section#browser-agent-access" : "section#devices",
      ),
    ).not.toBeNull(),
  );
  stack.move();
  return screen;
}

describe("Integrations browser discovery", () => {
  it("keeps agent browser access in its extracted browser section", async () => {
    setup();
    await using screen = await openSettings();

    expect(
      page.getByRole("heading", { name: "Agent access", exact: true }).elements(),
    ).toHaveLength(1);
    const access = page.getByRole("switch", { name: "Agent browser access", exact: true });
    await expect.element(access).toBeVisible();
    expect(access.element().closest("section")).toBe(
      screen.container.querySelector("section#browser-agent-access"),
    );
    expect(access.element().closest("#agent-browser-access")).not.toBeNull();
  });

  it("groups the extracted browser controls together", async () => {
    setup();
    await using screen = await openSettings();
    const sections = Array.from(
      screen.container.querySelectorAll("section[id]"),
      (section) => section.id,
    );
    expect(sections).toEqual(["browser-agent-access", "browser", "browser-recordings"]);
  });
  it("keeps voice and dictation on the Devices page", async () => {
    setup();
    await using screen = await openSettings("devices");
    const sections = Array.from(
      screen.container.querySelectorAll("section[id]"),
      (section) => section.id,
    );
    expect(sections).toEqual(["devices", "integrations-voice"]);
  });
});
