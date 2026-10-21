// @effect-diagnostics nodeBuiltinImport:off -- Process integration fixtures use native temporary files.
import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { vi } from "vite-plus/test";

import { ContentSearchProcess } from "./ContentSearchProcess.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project");
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 512 });
    }),
  ),
);

it.effect("waits for the full content index warmup before returning", () =>
  Effect.gen(function* () {
    const waitForIndexReady = vi.fn(async () => ({ ok: true as const, value: true }));
    vi.spyOn(ContentSearchProcess.prototype, "create").mockResolvedValueOnce({
      ok: true,
      value: undefined,
    });
    vi.spyOn(ContentSearchProcess.prototype, "waitForIndexReady").mockImplementationOnce(
      waitForIndexReady,
    );

    yield* Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content"));

    expect(waitForIndexReady).toHaveBeenCalledWith(15_000);
  }),
);

it.effect("preserves a full-index warmup timeout as a structured error", () =>
  Effect.gen(function* () {
    const finder = {
      destroy: vi.fn(),
      waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: false })),
    } as unknown as FileFinder;
    vi.spyOn(ContentSearchProcess.prototype, "create").mockResolvedValueOnce({
      ok: true,
      value: undefined,
    });
    vi.spyOn(ContentSearchProcess.prototype, "waitForIndexReady").mockImplementationOnce(
      finder.waitForIndexReady,
    );

    const error = yield* Effect.flip(
      Effect.scoped(WorkspaceSearchIndex.make("/workspace/project", "content")),
    );

    expect(error).toMatchObject({
      _tag: "WorkspaceSearchIndexScanTimedOut",
      cwd: "/workspace/project",
      timeout: "15 seconds",
    });
  }),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "paths");
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);

it.effect("pages image candidates until the requested filtered page is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 1200 }, (_, index) => fileItem(`src/${index}.ts`)),
        fileItem("one.png"),
        fileItem("two.svg"),
      ];
      const fileSearch = vi.fn(
        (_query: string, options?: { pageSize?: number; pageIndex?: number }) => {
          const start = (options?.pageIndex ?? 0) * (options?.pageSize ?? 1);
          return {
            ok: true as const,
            value: {
              items: items.slice(start, start + (options?.pageSize ?? 1)),
              scores: [],
              totalMatched: items.length,
              totalFiles: items.length,
            },
          };
        },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: async () => ({ ok: true as const, value: true }),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make("/workspace/project");
      const result = yield* index.search("", 1, "file", true);
      expect(result.entries).toEqual([{ path: "one.png", kind: "file" }]);
      expect(result.truncated).toBe(true);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("invalidates cached listings on watcher events and explicit refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let changed: (() => void) | undefined;
      const mixedSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items: [{ type: "file" as const, item: fileItem("one.ts") }],
          scores: [],
          totalMatched: 1,
          totalFiles: 1,
          totalDirs: 0,
        },
      }));
      const unsubscribe = vi.fn();
      const finder = {
        destroy: vi.fn(),
        isScanning: () => false,
        watch: (callback: () => void) => {
          changed = callback;
          return { ok: true, value: unsubscribe };
        },
        scanFiles: () => ({ ok: true, value: undefined }),
        waitForIndexReady: async () => ({ ok: true, value: true }),
        mixedSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make("/workspace/project");
      yield* index.list();
      yield* index.list();
      expect(mixedSearch).toHaveBeenCalledTimes(1);
      changed?.();
      yield* index.list();
      expect(mixedSearch).toHaveBeenCalledTimes(2);
      yield* index.refresh();
      yield* index.list();
      expect(mixedSearch).toHaveBeenCalledTimes(3);
    }),
  ),
);

it.effect("refreshes again for writes requested while a scan is in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let markStarted!: () => void;
      let releaseScan!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      let scans = 0;
      const finder = {
        destroy: vi.fn(),
        scanFiles: () => {
          scans += 1;
          return { ok: true, value: undefined };
        },
        waitForIndexReady: async () => {
          if (scans === 1) {
            markStarted();
            await waiting;
          }
          return { ok: true, value: true };
        },
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make("/workspace/project");
      const first = yield* Effect.forkChild(index.refresh());
      yield* Effect.promise(() => started);
      const second = yield* Effect.forkChild(index.refresh(), { startImmediately: true });
      releaseScan();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(scans).toBe(2);
    }),
  ),
);

it.effect("runs native content search in an isolated process with Unicode match offsets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-content-process-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, "sample.txt"),
          "é😀 needle needleSuffix needle\n",
        ),
      );
      const index = yield* WorkspaceSearchIndex.make(directory, "content");
      const result = yield* index.searchContents({
        query: "needle",
        limit: 10,
        wholeWord: true,
        caseSensitive: true,
        useRegex: false,
      });
      expect(result.matches[0]?.matchRanges).toEqual([
        { start: 4, end: 10 },
        { start: 24, end: 30 },
      ]);
    }),
  ),
);

it.effect("bounds sparse image searches to two native calls regardless of UI result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSearch = vi.fn((_query: string, options?: { pageSize?: number }) => ({
        ok: true as const,
        value: {
          items: Array.from({ length: options?.pageSize ?? 0 }, (_, index) =>
            fileItem(`src/${index}.ts`),
          ),
          scores: [],
          totalMatched: 100_000,
          totalFiles: 100_000,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: async () => ({ ok: true as const, value: true }),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });
      const index = yield* WorkspaceSearchIndex.make("/workspace/project");
      expect(yield* index.search("", 1, "file", true)).toEqual({ entries: [], truncated: true });
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch.mock.calls.map((call) => call[1]?.pageSize)).toEqual([512, 25_002]);
    }),
  ),
);
