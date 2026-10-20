import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  share: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(cache: string, name: string) {
      this.uri = `${cache}/${name}`;
    }

    create(): void {
      mocks.directories.add(this.uri);
    }

    delete(): void {
      mocks.directories.delete(this.uri);
      for (const uri of mocks.files.keys()) {
        if (uri.startsWith(`${this.uri}/`)) mocks.files.delete(uri);
      }
    }
  }

  class File {
    readonly uri: string;

    constructor(directory: Directory, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }

    create(): void {
      mocks.create();
      mocks.files.set(this.uri, "");
    }

    write(content: string): void {
      mocks.write();
      mocks.files.set(this.uri, content);
    }
  }

  return { Directory, File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo-sharing", () => ({ shareAsync: mocks.share }));

import { shareThreadExport } from "./threadExport";

const exported = {
  filename: "conversation.md",
  content: "# Conversation\n\nPrivate thread text.",
  mimeType: "text/markdown",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.files.clear();
  mocks.directories.clear();
});

describe("shareThreadExport", () => {
  it("keeps the exported content available until sharing settles, then removes it", async () => {
    let completeShare!: () => void;
    const sharing = new Promise<void>((resolve) => {
      completeShare = resolve;
    });
    let startedSharing!: () => void;
    const started = new Promise<void>((resolve) => {
      startedSharing = resolve;
    });
    mocks.share.mockImplementation(() => {
      startedSharing();
      return sharing;
    });

    const pendingExport = shareThreadExport(exported);
    await started;
    expect([...mocks.files]).toEqual([
      [expect.stringMatching(/\/conversation\.md$/), "# Conversation\n\nPrivate thread text."],
    ]);
    expect(mocks.share).toHaveBeenCalledWith(expect.any(String), {
      mimeType: "text/markdown",
      dialogTitle: "Export thread",
    });
    expect(mocks.directories.size).toBe(1);
    completeShare();
    await pendingExport;

    expect(mocks.share).toHaveBeenCalledOnce();
    expect(mocks.files.size).toBe(0);
    expect(mocks.directories.size).toBe(0);
  });

  it.each(["create", "write", "share"] as const)(
    "removes temporary export data and preserves the error when %s fails",
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      if (stage === "share") mocks.share.mockRejectedValue(failure);
      else
        mocks[stage].mockImplementation(() => {
          throw failure;
        });

      await expect(shareThreadExport(exported)).rejects.toBe(failure);

      expect(mocks.files.size).toBe(0);
      expect(mocks.directories.size).toBe(0);
      if (stage !== "share") expect(mocks.share).not.toHaveBeenCalled();
    },
  );
});
