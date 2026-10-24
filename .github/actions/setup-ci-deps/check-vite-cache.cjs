const { appendFileSync, existsSync, realpathSync } = require("node:fs");
const { dirname, join, relative, isAbsolute } = require("node:path");
const { execFileSync } = require("node:child_process");

const [root, version, nodeVersion, packageManager, mode] = process.argv.slice(2);
const bin = join(root, "bin");
const vp = join(bin, "vp");
const env = {
  ...process.env,
  VP_HOME: root,
  PATH: `${bin}${require("node:path").delimiter}${process.env.PATH}`,
};
const run = (command, args) =>
  execFileSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function check() {
  // An incomplete restore must not invoke the CLI's first-start installer.
  // Vite+ 1.3 writes this marker beside the deployed executable after setup.
  if (!existsSync(join(dirname(realpathSync(vp)), ".vp-setup-complete"))) {
    throw new Error("Vite+ setup is incomplete");
  }
  if (run(vp, ["--version"]).split(/\r?\n/)[0] !== `vp v${version}`) {
    throw new Error("Cached Vite+ version does not match");
  }
  const current = JSON.parse(run(vp, ["env", "current", "--json"]));
  if (
    current.node?.version !== nodeVersion ||
    current.node?.installed !== true ||
    current.node?.mode !== "managed" ||
    current.package_manager?.name !== "pnpm" ||
    `pnpm@${current.package_manager?.version}` !== packageManager ||
    current.package_manager?.installed !== true ||
    current.package_manager?.mode !== "managed"
  ) {
    throw new Error("Cached Node.js or pnpm is missing or does not match");
  }
  for (const path of [current.node.bin_path, current.package_manager.bin_paths.pnpm]) {
    const child = relative(realpathSync(root), realpathSync(path));
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${require("node:path").sep}`)) {
      throw new Error("Resolved tool is outside the Vite+ cache");
    }
  }
  // Check executable behavior as well as the CLI's reported installation state.
  if (
    run(join(bin, "node"), ["--version"]) !== `v${nodeVersion}` ||
    run(join(bin, "pnpm"), ["--version"]) !== packageManager.slice("pnpm@".length)
  ) {
    throw new Error("Cached runtime executables do not match");
  }
  run(vp, ["env", "use", nodeVersion]);
}

try {
  check();
  appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, "usable=true\n");
} catch (error) {
  console.error(`Vite+ cache is unusable: ${error.message}`);
  appendFileSync(process.env.GITHUB_OUTPUT, "usable=false\n");
  if (mode === "required") process.exitCode = 1;
}
