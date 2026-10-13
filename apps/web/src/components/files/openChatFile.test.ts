import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectReadFileError } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { openChatFile } from "./openChatFile";

describe("chat file default app fallback", () => {
  it.each([
    "binary_file",
    "path_not_file",
    "operation_failed",
    "workspace_path_outside_root",
  ] as const)("only launches the default app for a confirmed binary file: %s", async (failure) => {
    const preview = vi.fn();
    const openDefaultApp = vi.fn(async () => AsyncResult.success(undefined));
    await openChatFile({
      read: async () =>
        AsyncResult.failure(
          Cause.fail(
            new ProjectReadFileError({ cwd: "/repo", relativePath: "report.docx", failure }),
          ),
        ),
      preview,
      openDefaultApp,
      isCurrent: () => true,
    });
    expect(openDefaultApp).toHaveBeenCalledTimes(failure === "binary_file" ? 1 : 0);
    expect(preview).toHaveBeenCalledTimes(failure === "binary_file" ? 0 : 1);
  });
  it("preserves text previews even with an unfamiliar extension", async () => {
    const preview = vi.fn();
    const openDefaultApp = vi.fn();
    await openChatFile({
      read: async () => AsyncResult.success({ contents: "let x = 1;" }),
      preview,
      openDefaultApp,
      isCurrent: () => true,
    });
    expect(preview).toHaveBeenCalledOnce();
    expect(openDefaultApp).not.toHaveBeenCalled();
  });
  it("does not launch after the user selects a different file", async () => {
    const preview = vi.fn();
    const openDefaultApp = vi.fn();
    await openChatFile({
      read: async () =>
        AsyncResult.failure(
          Cause.fail(
            new ProjectReadFileError({
              cwd: "/repo",
              relativePath: "report.docx",
              failure: "binary_file",
            }),
          ),
        ),
      preview,
      openDefaultApp,
      isCurrent: () => false,
    });
    expect(preview).not.toHaveBeenCalled();
    expect(openDefaultApp).not.toHaveBeenCalled();
  });
  it("returns a default-app failure without replacing it with a text preview", async () => {
    const failed = AsyncResult.failure(Cause.fail(new Error("No associated application")));
    const preview = vi.fn();
    expect(
      await openChatFile({
        read: async () =>
          AsyncResult.failure(
            Cause.fail(
              new ProjectReadFileError({
                cwd: "/repo",
                relativePath: "report.docx",
                failure: "binary_file",
              }),
            ),
          ),
        preview,
        openDefaultApp: async () => failed,
        isCurrent: () => true,
      }),
    ).toBe(failed);
    expect(preview).not.toHaveBeenCalled();
  });
});
