import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects, useQuietThreadShells } from "../state/entities";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { makeThreadFixture } from "../test-fixtures";
import "~/index.css";
import { SidebarProvider, Sidebar as SidebarShell, useSidebar } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
    { mode: "legacy", count: 2, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
      legacySidebarEnabled: scenario.mode === "legacy",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function OpenMobileSidebar() {
  const { setOpenMobile } = useSidebar();
  return <button onClick={() => setOpenMobile(true)}>Open sidebar</button>;
}

describe("mobile project groups", () => {
  it("shows running project threads in Working when folders are enabled", async () => {
    using stack = new DisposableStack();
    const previous = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previous));
    stack.defer(() => {
      void page.viewport(1280, 800);
    });
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: true,
      sidebarProjectGroupingMode: "repository",
      sidebarWorkingShelfEnabled: true,
    });
    const projects = [project("alpha"), project("beta")];
    vi.mocked(useProjects).mockReturnValue(projects);
    const running = makeThreadFixture({
      id: ThreadId.make("running-project-thread"),
      title: "Running project thread",
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    });
    const idle = makeThreadFixture({
      id: ThreadId.make("idle-project-thread"),
      title: "Idle project thread",
      environmentId: projects[1]!.environmentId,
      projectId: projects[1]!.id,
    });
    vi.mocked(useQuietThreadShells).mockReturnValue([
      {
        ...running,
        runtime: {
          status: "running",
          activeRunId: null,
          providerInstanceId: running.providerInstanceId,
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      },
      idle,
    ]);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: null,
      handleNewThread: vi.fn(),
      routeDraftId: null,
      routeThreadRef: null,
    });
    await page.viewport(390, 800);
    await using screen = await render(
      <SidebarProvider>
        <OpenMobileSidebar />
        <SidebarShell>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarShell>
      </SidebarProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="sidebar-working-header"]')).not.toBeNull(),
    );
    const toggle = page.getByTestId("sidebar-working-shelf-toggle");
    if (toggle.element().getAttribute("aria-expanded") === "false") await userEvent.click(toggle);
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-thread-item="local:running-project-thread"]'),
      ).toHaveLength(1),
    );
    expect(
      document
        .querySelector('[data-thread-item="local:running-project-thread"] [data-sidebar-row]')
        ?.getAttribute("data-sidebar-parent"),
    ).toBe("shelf:working");
    vi.mocked(useQuietThreadShells).mockReturnValue([
      { ...running, hasPendingApprovals: true },
      idle,
    ]);
    await screen.rerender(
      <SidebarProvider>
        <OpenMobileSidebar />
        <SidebarShell>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarShell>
      </SidebarProvider>,
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="sidebar-working-header"]')).toBeNull(),
    );
    const folder = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="sidebar-project-folder"]'),
    ).find((el) => el.textContent?.includes("alpha"));
    expect(folder).toBeDefined();
    const folderToggle = folder!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    if (folderToggle.getAttribute("aria-expanded") === "false") await userEvent.click(folderToggle);
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-thread-item="local:running-project-thread"]'),
      ).toHaveLength(1),
    );
    expect(
      document
        .querySelector('[data-thread-item="local:running-project-thread"] [data-sidebar-row]')
        ?.getAttribute("data-sidebar-parent"),
    ).toBe(folderToggle.getAttribute("data-sidebar-row"));
  });

  it.each([
    [false, 320],
    [false, 360],
    [false, 390],
    [true, 320],
    [true, 360],
    [true, 390],
  ] as const)(
    "keeps grouped rows within the sheet (boring=%s, width=%s)",
    async (boring, width) => {
      using stack = new DisposableStack();
      const previous = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previous));
      stack.defer(() => {
        void page.viewport(1280, 800);
      });
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        boringSidebarEnabled: boring,
        sidebarProjectGroupingMode: "repository",
      });
      const p = project("an-extremely-long-project-name-that-must-not-expand-the-sidebar");
      vi.mocked(useProjects).mockReturnValue([p]);
      const threads = Array.from({ length: 124 }, (_, index) => {
        const id = ThreadId.make(`mobile-thread-${index}`);
        const thread = makeThreadFixture({
          id,
          environmentId: p.environmentId,
          projectId: p.id,
          runtime: null,
          lastVisitedAt: "2026-01-01T00:00:00.000Z",
          latestRun: {
            runId: RunId.make(`mobile-run-${index}`),
            status: "completed",
            assistantMessageId: null,
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-02T00:00:00.000Z",
          },
        });
        if (index < 12) return { ...thread, hasPendingApprovals: true };
        if (index < 24)
          return {
            ...thread,
            runtime: {
              status: "failed" as const,
              activeRunId: null,
              providerInstanceId: thread.providerInstanceId,
              providerName: "Codex",
              lastError: "Failed",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          };
        return thread;
      });
      vi.mocked(useQuietThreadShells).mockReturnValue(threads);
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: null,
        handleNewThread: vi.fn(),
        routeDraftId: null,
        routeThreadRef: null,
      });
      await page.viewport(width, 800);
      await using screen = await render(
        <SidebarProvider>
          <OpenMobileSidebar />
          <SidebarShell>
            <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
          </SidebarShell>
        </SidebarProvider>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }));
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            boring
              ? '[data-testid="sidebar-project-folder"]'
              : '[data-testid="sidebar-repository-group"]',
          ),
        ).not.toBeNull(),
      );
      const row = document.querySelector<HTMLElement>(
        boring
          ? '[data-testid="sidebar-project-folder"]'
          : '[data-testid="sidebar-repository-group"]',
      )!;
      const sheet = row.closest<HTMLElement>('[data-slot="sidebar"]')!;
      const handle = row.querySelector<HTMLElement>(
        '[data-testid="sidebar-repository-group-handle"]',
      )!;
      expect(handle.getBoundingClientRect().right).toBeLessThanOrEqual(
        sheet.getBoundingClientRect().right,
      );
      expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
        sheet.getBoundingClientRect().right,
      );
      expect(sheet.scrollWidth).toBeLessThanOrEqual(sheet.clientWidth);
      const toggle = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
      if (toggle.getAttribute("aria-expanded") === "false") await userEvent.click(toggle);
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
      await userEvent.click(toggle);
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
      const statuses = row.querySelector<HTMLElement>("[data-collapsed-thread-statuses]")!;
      expect(statuses).not.toBeNull();
      expect(statuses.querySelectorAll('[role="img"]')).toHaveLength(3);
      expect(statuses.textContent).toContain("×100");
      expect(statuses.getBoundingClientRect().right).toBeLessThanOrEqual(
        toggle.getBoundingClientRect().right,
      );
      if (matchMedia("(pointer: coarse)").matches) {
        expect(handle.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
        expect(handle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      const label = Array.from(toggle.querySelectorAll("span")).find(
        (span) => span.textContent === p.title,
      )!;
      expect(label.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
      expect(label.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        statuses.getBoundingClientRect().top,
      );
      await userEvent.click(toggle);
      await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    },
  );
});
