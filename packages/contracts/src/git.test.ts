import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsListRefsResult,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);

describe("VcsListRefsResult", () => {
  it("decodes a physical worktree inventory including detached entries", () => {
    const parsed = decodeListRefsResult({
      refs: [],
      worktrees: [
        { path: "/repo", refName: "main", isMain: true },
        { path: "/repo-detached", refName: null, isMain: false },
      ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 0,
    });

    expect(parsed.worktrees).toHaveLength(2);
    expect(parsed.worktrees?.[1]).toEqual({
      path: "/repo-detached",
      refName: null,
      isMain: false,
    });
  });

  it("keeps worktrees optional for older servers", () => {
    const parsed = decodeListRefsResult({
      refs: [],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 0,
    });

    expect(parsed.worktrees).toBeUndefined();
  });
});

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});
