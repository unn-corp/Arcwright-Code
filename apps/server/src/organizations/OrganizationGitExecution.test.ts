// @effect-diagnostics nodeBuiltinImport:off - Verify native executable discovery and private Git execution boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  resolveOrganizationGitExecution,
  withOrganizationGitExecution,
} from "./OrganizationGitExecution.ts";

const resolver = vi.hoisted(() => ({
  result: {
    command: "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe",
    args: [] as string[],
    shell: false,
  },
  env: undefined as NodeJS.ProcessEnv | undefined,
  aliases: {} as Record<string, string>,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, realpathSync: (path: string) => resolver.aliases[path] ?? path };
});
vi.mock("@t3tools/shared/shell", async () => {
  const Effect = await import("effect/Effect");
  return {
    resolveSpawnCommand: (
      _command: string,
      _args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      resolver.env = options.env;
      return Effect.succeed(resolver.result);
    },
  };
});

it("discovers Windows Git outside the repository without inheriting executable or Git overrides", () => {
  resolver.aliases = { "C:\\work-alias": "C:\\work\\repo", "C:\\Alias": "C:\\work\\repo\\bin" };
  const host = {
    platform: "win32" as const,
    env: {
      Path: ';.;bin;C:\\work\\repo;C:\\work\\repo\\bin;C:\\Alias;\\\\server\\share;"C:\\Program Files\\Git\\cmd";C:\\Windows\\System32',
      SystemRoot: "C:\\Windows",
      GIT_DIR: "C:\\attacker",
      GIT_CONFIG_COUNT: "1",
      NODE_OPTIONS: "--require=attacker",
    },
  };
  try {
    const execution = resolveOrganizationGitExecution("C:\\work-alias", host);
    assert.deepEqual(resolver.env, {
      PATH: "C:\\Program Files\\Git\\cmd;C:\\Windows\\System32",
      PATHEXT: ".EXE",
    });
    assert.equal(execution.command, resolver.result.command);
    assert.equal(execution.env.PATH, "C:\\Program Files\\Git\\ucrt64\\bin;C:\\Windows\\System32");
    assert.isUndefined(execution.env.GIT_DIR);
    assert.isUndefined(execution.env.GIT_CONFIG_COUNT);
    assert.isUndefined(execution.env.NODE_OPTIONS);
    assert.equal(execution.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(execution.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(execution.env.GIT_CONFIG_GLOBAL, "NUL");
  } finally {
    resolver.aliases = {};
  }
});

it("refuses unresolved commands, shell wrappers, and network executables on Windows", () => {
  const saved = resolver.result;
  const host = { platform: "win32" as const, env: { PATH: "C:\\Git\\bin" } };
  try {
    for (const result of [
      { command: "git.exe", shell: false },
      { command: "C:\\Git\\git.cmd", shell: true },
      { command: "\\\\server\\git.exe", shell: false },
    ]) {
      resolver.result = { ...result, args: [] };
      assert.throws(
        () => resolveOrganizationGitExecution("C:\\work\\repo", host),
        "native Git executable",
      );
    }
  } finally {
    resolver.result = saved;
  }
});

it("uses a real empty hook directory and removes it even when the Git operation fails", async () => {
  let hooks = "";
  await expect(
    withOrganizationGitExecution(NodeOS.tmpdir(), async (execution) => {
      hooks = execution.args[1]!.slice("core.hooksPath=".length);
      assert.isTrue(NodePath.isAbsolute(hooks));
      assert.deepEqual(await NodeFSP.readdir(hooks), []);
      assert.equal(
        execution.env.GIT_CONFIG_GLOBAL,
        HostProcess.Platform.defaultValue() === "win32" ? "NUL" : "/dev/null",
      );
      throw new Error("Fixture Git failure");
    }),
  ).rejects.toThrow("Fixture Git failure");
  await expect(NodeFSP.stat(hooks)).rejects.toMatchObject({ code: "ENOENT" });
});
