import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { act, fakeTimers, render as renderUi, type Screen } from "../../../test/render";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type DesktopPreviewAnnotationSnapshot,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { Profiler, type ComponentProps, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  captureAnnotationSnapshot: vi.fn(),
  renderAnnotationScreenshot: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toast: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  nativeServerTab: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    captureAnnotationSnapshot: mocks.captureAnnotationSnapshot,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            runtime: mocks.nativeServerTab ? "server" : "desktop",
            navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } };
});
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";
import { PreviewAnnotationEditorHost } from "./PreviewAnnotationEditor";

import {
  registerPreviewAnnotationSender,
  usePreviewAnnotationEditorStore,
  usePreviewAnnotationSenders,
} from "~/previewAnnotationEditorStore";

vi.mock(import("~/lib/previewAnnotationEditor"), async (original) => ({
  ...(await original()),
  renderAnnotationScreenshot: mocks.renderAnnotationScreenshot,
}));

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

async function render(root: Screen, node: ReactNode) {
  await act(async () => root.rerender(node));
}

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  if (onSendAnnotation) registerPreviewAnnotationSender(TEST_THREAD_REF, onSendAnnotation);
  return (
    <>
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
      <PreviewAnnotationEditorHost />
    </>
  );
}

const snapshot: DesktopPreviewAnnotationSnapshot = {
  pageUrl: "https://example.com/dashboard",
  pageTitle: "Dashboard",
  width: 800,
  height: 600,
  elements: [],
  createdAt: "2026-10-08T00:00:00.000Z",
  screenshot: {
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=",
    width: 800,
    height: 600,
    cropRect: { x: 0, y: 0, width: 800, height: 600 },
  },
};

async function captureAnnotation() {
  await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
  await vi.waitFor(() =>
    expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("ready"),
  );
}

async function submitAddress(text: string) {
  const input = page.getByPlaceholder("Search or enter URL");
  await userEvent.click(input);
  await userEvent.fill(input, text);
  await userEvent.keyboard("{Enter}");
}

function hasCursor() {
  return document.querySelector("svg.lucide-mouse-pointer2") !== null;
}

describe("PreviewView", () => {
  async function setup() {
    vi.clearAllMocks();
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
    mocks.pickElement.mockReset();
    mocks.captureAnnotationSnapshot.mockReset().mockResolvedValue(snapshot);
    mocks.renderAnnotationScreenshot
      .mockReset()
      .mockImplementation(async (annotation: PreviewAnnotationPayload) => annotation);
    usePreviewAnnotationEditorStore.setState({ session: null, hydrated: true });
    usePreviewAnnotationSenders.setState({ senders: new Map() });
    mocks.pictureInPicture = false;
    mocks.showEmptyState = false;
    mocks.loading = false;
    mocks.nativeServerTab = false;
    mocks.serverEpoch = null;
    mocks.servers = [];
    mocks.recordingTabIds = new Set();
    mocks.recordingRuntimeTabId = null;
    useComposerDraftStore.setState({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    });
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    useBrowserPointerStore.setState({ byTabId: {} });
    // Navigation is mocked; this fixture exercises only the panel or bridge.
    const root = await renderUi(null, { router: false });
    return {
      root,
      container: root.container,
      async [Symbol.asyncDispose]() {
        await root[Symbol.asyncDispose]();
        usePreviewAnnotationEditorStore.setState({ session: null });
        usePreviewAnnotationSenders.setState({ senders: new Map() });
        vi.useRealTimers();
        vi.unstubAllGlobals();
      },
    };
  }

  it("shows the cursor in a replacement browser while the old instance still records", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    mocks.recordingTabIds.add(TEST_RUNTIME_TAB_ID);
    mocks.recordingRuntimeTabId = TEST_RUNTIME_TAB_ID;
    const replacementTabId = previewRuntimeTabId(TEST_THREAD_REF, "replacement-server", "tab-1");
    useBrowserPointerStore.setState({
      byTabId: Object.fromEntries(
        [TEST_RUNTIME_TAB_ID, replacementTabId].map((tabId) => [
          tabId,
          { tabId, phase: "move", x: 10, y: 10, sequence: 1, createdAt: "2026-07-27T00:00:00Z" },
        ]),
      ),
    });
    await render(root, view());
    expect(hasCursor()).toBe(false);
    mocks.serverEpoch = "replacement-server";
    await render(root, view());
    expect(hasCursor()).toBe(true);
    expect(mocks.recordingTabIds.has(TEST_RUNTIME_TAB_ID)).toBe(true);
  });

  it.each([false, true])(
    "aligns the cursor and responsive viewport after host zoom changes (native server tab: %s)",
    async (nativeServerTab) => {
      await using _fixture = await setup();
      const { root } = _fixture;
      mocks.nativeServerTab = nativeServerTab;
      let windowZoom = 1;
      vi.stubGlobal("desktopBridge", {
        getWindowZoomFactor: () => windowZoom,
        getLocalEnvironmentBootstraps: () => [],
      });
      const commit = vi.mocked(commitBrowserViewportChange).mockResolvedValueOnce(undefined);
      try {
        await render(root, view());
        await act(() => {
          const surfaces = useBrowserSurfaceStore.getState();
          const slot = document.querySelector<HTMLElement>("[data-browser-surface-slot]")!;
          slot.style.width = "1020px";
          slot.style.height = "798px";
          surfaces.presentContent(TEST_RUNTIME_TAB_ID, {
            x: 20,
            y: 40,
            width: 500,
            height: 375,
            scale: 0.5,
            scrollLeft: 7,
            scrollTop: 11,
          });
          useBrowserPointerStore.setState({
            byTabId: {
              [TEST_RUNTIME_TAB_ID]: {
                tabId: TEST_RUNTIME_TAB_ID,
                phase: "move",
                x: 100,
                y: 200,
                sequence: 1,
                createdAt: "2026-07-27T00:00:00Z",
              },
            },
          });
          windowZoom = 1.25;
          window.dispatchEvent(new Event("resize"));
        });
        const cursor = document.querySelector("[data-agent-browser-cursor]");
        expect(cursor).not.toBeNull();
        const position = new DOMMatrixReadOnly(getComputedStyle(cursor!).transform);
        expect(position.e).toBe(53);
        expect(position.f).toBe(109);

        await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
        await userEvent.click(page.getByRole("menuitem", { name: "Show device toolbar" }));
        expect(commit).toHaveBeenCalledExactlyOnceWith(TEST_RUNTIME_TAB_ID, {
          _tag: "freeform",
          width: 1250,
          height: 938,
        });
      } finally {
        commit.mockReset();
        await act(() => useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} }));
      }
    },
  );

  it("does not rerender while loading time passes", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    using _timers = fakeTimers();
    mocks.loading = true;
    const onRender = vi.fn();
    await render(
      root,
      <Profiler id="preview" onRender={onRender}>
        {view()}
      </Profiler>,
    );
    const initialRenderCount = onRender.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
  });

  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://localhost:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://localhost:5173/app"],
  ])(
    "preserves a direct localhost URL %s in a WSL environment and records it",
    async (submitted, expected) => {
      await using _fixture = await setup();
      const { root } = _fixture;
      await render(root, view());
      await submitAddress(submitted);
      await vi.waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
      );
      expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
    },
  );

  it("maps an empty-state localhost server onto the WSL host", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    mocks.showEmptyState = true;
    mocks.servers = [
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/app?mode=test#top",
        requestedUrl: "http://localhost:5173/app?mode=test#top",
        processName: "vite",
        pid: 1,
        terminal: null,
        source: "scanner",
      } as unknown as PreviewableServer,
    ];
    await render(root, view());
    await userEvent.click(page.getByRole("button", { name: /vite/ }));

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.25.85.75:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      TEST_THREAD_REF,
      "http://172.25.85.75:5173/app?mode=test#top",
    );
    // History keys off the requested loopback URL, which stays stable across hosts.
    await vi.waitFor(() =>
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/app?mode=test#top",
      ),
    );
  });

  it("opens and closes a thread-scoped floating preview for the active tab", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    await render(root, view());
    await userEvent.click(page.getByRole("button", { name: "Float preview over chat" }));
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toMatchObject({
      "environment-1:thread-1": { source: { kind: "browser", tabId: "tab-1" } },
    });
    const closeButton = page.getByRole("button", { name: "Close floating preview" });
    await expect.element(closeButton).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(closeButton);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("keeps the native preview window as a secondary menu action", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    await render(root, view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    mocks.pictureInPicture = true;
    await render(root, view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Close separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.closePictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });

  it.each(["Control", "Meta"])(
    "forwards %s+Enter annotations from the durable modal to the original composer",
    async (modifier) => {
      await using _fixture = await setup();
      const { root } = _fixture;
      const onSendAnnotation = vi.fn();
      await render(root, view(onSendAnnotation));
      await captureAnnotation();
      await userEvent.fill(
        page.getByRole("textbox", { name: "Describe the change" }),
        "Tighten this spacing",
      );
      await userEvent.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);

      const picked = expect.objectContaining({
        pageUrl: snapshot.pageUrl,
        comment: "Tighten this spacing",
        screenshot: snapshot.screenshot,
      });
      await vi.waitFor(() =>
        expect(onSendAnnotation).toHaveBeenCalledWith(
          picked,
          expect.objectContaining({ type: "image", previewUrl: snapshot.screenshot.dataUrl }),
        ),
      );
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked);
      expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
      expect(mocks.pickElement).not.toHaveBeenCalled();
    },
  );

  it("retains the annotation locally when its own environment loses access during submission", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    const onSendAnnotation = vi.fn();
    let finishRender!: (annotation: PreviewAnnotationPayload) => void;
    let pendingAnnotation!: PreviewAnnotationPayload;
    mocks.renderAnnotationScreenshot.mockImplementationOnce(
      (annotation: PreviewAnnotationPayload) => {
        pendingAnnotation = annotation;
        return new Promise<PreviewAnnotationPayload>((resolve) => {
          finishRender = resolve;
        });
      },
    );
    await render(root, view(onSendAnnotation));
    await captureAnnotation();
    await userEvent.click(page.getByRole("button", { name: "Send annotation", exact: true }));
    await vi.waitFor(() => expect(finishRender).toBeDefined());
    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await render(root, view());
    await act(async () => finishRender(pendingAnnotation));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, pendingAnnotation);
    expect(mocks.addImage).toHaveBeenCalledWith(
      TEST_THREAD_REF,
      expect.objectContaining({ previewUrl: snapshot.screenshot.dataUrl }),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();
    expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();

    mocks.readEnvironmentScope.mockReturnValue(true);
    await render(root, view());
    await captureAnnotation();
    await userEvent.click(page.getByRole("button", { name: "Send annotation", exact: true }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledOnce());
  });

  it("does not reopen a discarded annotation after its snapshot capture finishes", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    let finishCapture!: (value: DesktopPreviewAnnotationSnapshot) => void;
    mocks.captureAnnotationSnapshot.mockImplementationOnce(
      () =>
        new Promise<DesktopPreviewAnnotationSnapshot>((resolve) => {
          finishCapture = resolve;
        }),
    );
    await render(root, view());
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(finishCapture).toBeDefined());
    await userEvent.click(page.getByRole("button", { name: "Close", exact: true }));
    expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("capturing");
    await userEvent.click(page.getByRole("button", { name: "Discard annotation", exact: true }));
    expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
    await act(async () => finishCapture(snapshot));
    expect(usePreviewAnnotationEditorStore.getState().session).toBeNull();
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps capture failures in the modal without sending an incomplete annotation", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    const onSendAnnotation = vi.fn();
    mocks.captureAnnotationSnapshot.mockRejectedValueOnce(
      new Error("Page reloaded during capture"),
    );
    await render(root, view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await expect.element(page.getByText("Page reloaded during capture")).toBeVisible();
    expect(usePreviewAnnotationEditorStore.getState().session?.status).toBe("error");
    await expect
      .element(page.getByRole("button", { name: "Send annotation", exact: true }))
      .toBeDisabled();
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(onSendAnnotation).not.toHaveBeenCalled();
  });

  it("preserves annotation text for retry when the captured screenshot is malformed", async () => {
    await using _fixture = await setup();
    const { root } = _fixture;
    const onSendAnnotation = vi.fn();
    mocks.renderAnnotationScreenshot.mockImplementationOnce(
      async (annotation: PreviewAnnotationPayload) => ({
        ...annotation,
        screenshot: { ...snapshot.screenshot, dataUrl: "data:image/png;base64,%%%" },
      }),
    );
    await render(root, view(onSendAnnotation));
    await captureAnnotation();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Describe the change" }),
      "Keep this comment",
    );
    await userEvent.click(page.getByRole("button", { name: "Send annotation", exact: true }));
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not prepare the screenshot. Your annotation is still saved.");
    expect(usePreviewAnnotationEditorStore.getState().session).toMatchObject({
      status: "ready",
      annotation: { comment: "Keep this comment" },
    });
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
    expect(mocks.addImage).not.toHaveBeenCalled();
    expect(onSendAnnotation).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Send annotation", exact: true }));
    await vi.waitFor(() =>
      expect(onSendAnnotation).toHaveBeenCalledWith(
        expect.objectContaining({ comment: "Keep this comment", screenshot: snapshot.screenshot }),
        expect.objectContaining({ type: "image" }),
      ),
    );
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    await using _fixture = await setup();
    await render(_fixture.root, view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });
});
