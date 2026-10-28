import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";

import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
  httpBaseUrl: "https://host.test",
}));

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: state.httpBaseUrl } }),
}));
vi.mock("~/state/filesystem", async () => {
  const { resolveFilesystemReadAccess } = await import("@t3tools/client-runtime/state/filesystem");
  return {
    useFilesystemReadAccess: () =>
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: state.phase, error: null },
        session: state.session,
        sessionError: null,
      }),
  };
});
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: state.assetQuery },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useAssetUrlRefresh, useAssetUrlState } from "./assetUrls";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.httpBaseUrl = "https://host.test";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["http://100.70.80.90:3773", "https://workstation.example.ts.net"])(
  "loads and refreshes evidence using the connected Tailscale origin %s",
  async (origin) => {
    state.httpBaseUrl = origin;
    state.session = {
      authenticated: true,
      scopes: [AuthOrchestrationReadScope],
    };
    const evidence = {
      ...resource,
      _tag: "conversation-evidence" as const,
      path: "/home/user/.t3/userdata/conversation-evidence/thread/screenshot.png",
    };
    expect(useAssetUrlState(environmentId, evidence)).toMatchObject({
      _tag: "Success",
      url: `${origin}/api/assets/image.png`,
    });
    await expect(useAssetUrlRefresh(environmentId, evidence)()).resolves.toBe(
      `${origin}/api/assets/image.png`,
    );
    expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource: evidence } });
  },
);
