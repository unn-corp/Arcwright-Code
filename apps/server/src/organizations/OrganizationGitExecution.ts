// @effect-diagnostics nodeBuiltinImport:off - Hardened raw Git plumbing uses native executable paths and private hook directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

/** Host PATH is used only to locate a native Windows Git; it is never inherited by Git. */
export function resolveOrganizationGitExecution(
  projectRoot: string,
  host: { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv } = {
    platform: HostProcess.Platform.defaultValue(),
    env: HostProcess.Environment.defaultValue(),
  },
) {
  let command = "/usr/bin/git";
  let systemRoot: string | undefined;
  if (host.platform === "win32") {
    const value = (name: string) =>
      Object.entries(host.env).find(([key]) => key.toUpperCase() === name)?.[1];
    const path = NodePath.win32;
    const root = NodeFS.realpathSync(projectRoot).toLowerCase();
    if (!/^[A-Za-z]:[\\/]/.test(root)) throw new Error("A local Project directory is required.");
    const outsideProject = (entry: string): string | null => {
      if (!/^[A-Za-z]:[\\/]/.test(entry)) return null;
      try {
        const canonical = NodeFS.realpathSync(entry);
        if (!/^[A-Za-z]:[\\/]/.test(canonical)) return null;
        const relative = path.relative(root, canonical.toLowerCase());
        return relative !== "" &&
          (relative === ".." || relative.startsWith("..\\") || path.isAbsolute(relative))
          ? canonical
          : null;
      } catch {
        return null;
      }
    };
    const hostPath = (value("PATH") ?? "")
      .split(";")
      .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
      // Resolve junctions too: an outside PATH entry can alias repository-owned files.
      .map(outsideProject)
      .filter((entry) => entry !== null)
      .join(";");
    const resolved = Effect.runSync(
      resolveSpawnCommand("git.exe", [], { env: { PATH: hostPath, PATHEXT: ".EXE" } }).pipe(
        Effect.provideService(HostProcess.Platform, host.platform),
      ),
    );
    if (
      resolved.shell ||
      !/^[A-Za-z]:[\\/]/.test(resolved.command) ||
      path.extname(resolved.command).toLowerCase() !== ".exe"
    )
      throw new Error("A native Git executable is required.");
    const canonicalCommand = outsideProject(resolved.command);
    if (!canonicalCommand || path.extname(canonicalCommand).toLowerCase() !== ".exe")
      throw new Error("A native Git executable outside the Project is required.");
    command = canonicalCommand;
    const candidate = value("SYSTEMROOT");
    if (candidate) systemRoot = outsideProject(candidate) ?? undefined;
  }
  const env: NodeJS.ProcessEnv = {
    PATH:
      host.platform === "win32"
        ? [
            NodePath.win32.dirname(command),
            ...(systemRoot ? [NodePath.win32.join(systemRoot, "System32")] : []),
          ].join(";")
        : "/usr/bin:/bin",
    ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodeOS.devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  return { command, env };
}

/** An empty private directory disables hooks on Windows too; NUL is not a directory. */
export async function withOrganizationGitExecution<T>(
  projectRoot: string,
  use: (
    execution: ReturnType<typeof resolveOrganizationGitExecution> & {
      readonly args: readonly string[];
    },
  ) => Promise<T>,
): Promise<T> {
  const execution = resolveOrganizationGitExecution(projectRoot);
  const hooks = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-git-hooks-"));
  try {
    return await use({
      ...execution,
      args: ["-c", `core.hooksPath=${hooks.replaceAll("\\", "/")}`, "-c", "core.fsmonitor=false"],
    });
  } finally {
    await NodeFSP.rm(hooks, { recursive: true, force: true });
  }
}
