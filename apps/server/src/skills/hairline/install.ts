// @effect-diagnostics nodeBuiltinImport:off - exclusive native file creation and inode checks define this synchronous boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import payload from "./payload.json" with { type: "json" };

function checkedDirectory(target: string) {
  const absolute = NodePath.resolve(target);
  let current = NodePath.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(NodePath.sep).filter(Boolean)) {
    current = NodePath.join(current, part);
    const info = NodeFS.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Hairline refuses symlink or non-directory workspace paths");
    }
  }
  return absolute;
}

/** Explicit project-scoped materialization; the provider keeps discovery and disable policy. */
export function installHairline(workspace: string, provider: string) {
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Hairline project installation supports codex or claude only");
  }
  const root = checkedDirectory(workspace);
  // A project path is required so a user's home cannot accidentally become the install target.
  if (
    root === NodeFS.realpathSync(NodeOS.homedir()) ||
    !NodeFS.existsSync(NodePath.join(root, ".git"))
  ) {
    throw new Error("Choose an existing Git workspace; Hairline never installs into a user home");
  }
  const nativeRoot = NodePath.join(root, provider === "codex" ? ".agents" : ".claude");
  const skillsRoot = NodePath.join(nativeRoot, "skills");
  for (const directory of [nativeRoot, skillsRoot]) {
    try {
      NodeFS.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    checkedDirectory(directory);
  }
  const target = NodePath.join(skillsRoot, "hairline-create");
  // mkdir is exclusive even for empty directories and dangling symlinks: never adopt existing data.
  NodeFS.mkdirSync(target, { mode: 0o700 });
  try {
    for (const [relative, contents] of Object.entries(payload)) {
      const file = NodePath.join(target, relative);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    // Leave partial output for inspection; retry refuses it rather than overwriting anything.
    throw new Error(`Hairline installation incomplete at ${target}; inspect before retrying`, {
      cause: error,
    });
  }
  return target;
}
