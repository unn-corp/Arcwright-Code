import { act, render as renderUi, type Screen } from "../../../test/render";
import {
  EnvironmentId,
  SourceControlProviderKind,
  type SourceControlDiscoveryResult,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const environmentId = EnvironmentId.make("host-search-test");
const discovery: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: SourceControlProviderKind.make("gitcafe"),
      label: "GitCafe",
      status: "available",
      version: Option.none(),
      installHint: "Configure GitCafe access",
      detail: Option.none(),
      auth: {
        status: "unknown",
        account: Option.none(),
        host: Option.none(),
        detail: Option.none(),
      },
    },
  ],
};

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: discovery,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => null,
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: [environmentId] },
    environment: { environmentId, label: "Test computer", connection: { phase: "connected" } },
    connectedEnvironments: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));
vi.mock(import("./SourceControlHostSettings"), async (original) => ({
  ...(await original()),
  SourceControlHostSettings: () => (
    <label>
      GitCafe host
      <input aria-label="GitCafe host" />
    </label>
  ),
}));
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: () => <></>,
}));
vi.mock(import("./WorktreeStorageSettings"), async (original) => ({
  ...(await original()),
  WorktreeStorageSettings: () => <></>,
}));
vi.mock(import("./BranchNamingSettings"), async (original) => ({
  ...(await original()),
  BranchNamingSettings: () => <></>,
}));
vi.mock(import("./RelocatedGeneralSettings"), async (original) => ({
  ...(await original()),
  SourceControlWorktreeSettings: () => <></>,
  SourceControlDiffSettings: () => <></>,
}));
vi.mock(import("./SourceControlWritingSettings"), async (original) => ({
  ...(await original()),
  SourceControlWritingSettingsSection: () => <></>,
}));

import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { sourceControlHostSettingsSearchId } from "./settingsSearch";

async function setup() {
  // The fixture supplies its own router.
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

it("reveals non-GitHub host settings through the page search provider and keeps them open after the hash clears", async () => {
  await using _fixture = await setup();
  const { root, container } = _fixture;
  const router = createRouter({
    routeTree: createRootRoute({ component: SourceControlSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => root.rerender(<RouterProvider router={router} />));
  const host = page.getByRole("textbox", { name: "GitCafe host" });
  expect(host.elements()).toHaveLength(0);

  const jump = () =>
    act(async () => {
      await router.navigate({ hash: sourceControlHostSettingsSearchId("gitcafe") });
    });
  await jump();
  await expect.element(host).toBeVisible();
  await vi.waitFor(() => expect(router.state.location.hash).toBe(""));
  const advanced = host.element().closest("details")!;
  expect(advanced.open).toBe(true);
  await userEvent.fill(host, "https://gitcafe.example.com");

  await userEvent.click(page.getByText("Advanced host configuration", { exact: true }));
  await vi.waitFor(() => expect(advanced.open).toBe(false));
  await jump();
  await expect.element(host).toBeVisible();
  await vi.waitFor(() => expect(router.state.location.hash).toBe(""));
  expect(advanced.open).toBe(true);
  await expect.element(host).toHaveValue("https://gitcafe.example.com");

  await userEvent.click(page.getByRole("button", { name: "Toggle GitCafe details" }));
  await vi.waitFor(() => expect(host.elements()).toHaveLength(0));
  await jump();
  await expect.element(host).toBeVisible();
  await vi.waitFor(() => expect(router.state.location.hash).toBe(""));
  expect(host.element().closest("details")!.open).toBe(true);
});
