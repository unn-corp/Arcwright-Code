import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn());
const assetState = vi.hoisted(() => ({
  result: null as unknown,
  origin: "https://host.test",
  listeners: new Set<() => void>(),
}));
vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (atom: { label?: readonly string[] }) => {
      const result = useSyncExternalStore(
        (listener) => {
          assetState.listeners.add(listener);
          return () => assetState.listeners.delete(listener);
        },
        () => assetState.result,
      );
      return atom.label?.[0] === "markdown-server-config-fields"
        ? {
            pullRequestsEnabled: false,
            availableEditors: [],
            revealInFileManagerLabel: "Show in file manager",
          }
        : result;
    },
  };
});
vi.mock("./media/MediaActions", () => ({
  MediaActions: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useFileMetadata", () => ({ useFileMetadata: () => undefined }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
  readPreparedConnection: () => ({ httpBaseUrl: assetState.origin }),
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: assetState.origin } }),
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

it("opens host media through server authorization before the client grant loads", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mint.mockResolvedValue(
    AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }),
  );
  const onImageExpand = vi.fn();
  const threadRef = {
    environmentId: EnvironmentId.make("media-environment"),
    threadId: ThreadId.make("media-thread"),
  };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd="/repo"
          threadRef={threadRef}
          text="[Open image](/tmp/image.png)"
          onImageExpand={onImageExpand}
        />,
      );
    });
    await act(async () => {
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href === "/tmp/image.png");
      expect(link).toBeDefined();
      link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    );
  } finally {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["/tmp/agent.png", "~/Pictures/agent.png", "C:/Users/alice/Pictures/agent.png"])(
  "refreshes a failed agent image once on the connected device: %s",
  async (imagePath) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    assetState.origin = "http://100.70.80.90:3773";
    assetState.result = AsyncResult.success({
      relativeUrl: "/api/assets/old/agent.png",
      expiresAt: 1,
    });
    mint.mockClear();
    mint.mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/new/agent.png", expiresAt: 99999 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("media-environment"),
      threadId: ThreadId.make("media-thread"),
    };
    const view = (
      <ChatMarkdown cwd="/repo" threadRef={threadRef} text={`![Agent result](${imagePath})`} />
    );
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(view);
      });
      const pending = renderer!.root.findByType("img");
      expect(pending.props.src).toBe("http://100.70.80.90:3773/api/assets/old/agent.png");
      await act(async () => {
        pending.props.onError();
      });
      expect(mint).toHaveBeenCalledTimes(1);
      expect(mint).toHaveBeenCalledWith({
        environmentId: threadRef.environmentId,
        input: {
          resource: { _tag: "media-file", threadId: threadRef.threadId, path: imagePath },
        },
      });
      assetState.result = AsyncResult.success({
        relativeUrl: "/api/assets/new/agent.png",
        expiresAt: 99999,
      });
      await act(async () => {
        for (const listener of assetState.listeners) listener();
      });
      const renewed = renderer!.root.findByType("img");
      expect(renewed.props.src).toBe("http://100.70.80.90:3773/api/assets/new/agent.png");
      await act(async () => {
        renewed.props.onError();
      });
      expect(mint).toHaveBeenCalledTimes(1);
      const retry = renderer!.root
        .findAllByType("button")
        .find((node) => node.children.includes("Retry image"));
      expect(retry).toBeDefined();
      await act(async () => {
        retry!.props.onClick({ stopPropagation: vi.fn() });
      });
      expect(mint).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => renderer?.unmount());
      assetState.result = null;
      assetState.origin = "https://host.test";
      vi.unstubAllGlobals();
    }
  },
);
