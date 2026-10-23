const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { test } = require("node:test");

const action = readFileSync(join(__dirname, "action.yml"), "utf8");
const steps = action.split(/(?=^    - name: )/m).slice(1);
function step(name) {
  const source = steps.find((text) => text.startsWith(`    - name: ${name}\n`));
  assert.ok(source, `Missing action step: ${name}`);
  return {
    condition: source.match(/^      if: (.+)$/m)?.[1],
    script: source.split("      run: |\n")[1]?.replace(/^        /gm, ""),
  };
}

function fixture(t) {
  const dir = mkdtempSync(join(process.env.T3CODE_CI_FIXTURE_ROOT || tmpdir(), "vite cache test "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "payload");
  mkdirSync(root);
  const values = {
    "github.action_path": dirname(require.resolve("./check-vite-cache.cjs")),
    "steps.vp.outputs.home": root,
    "steps.vp.outputs.version": "1.3.0",
    "steps.vp.outputs.node": "26.12.1",
    "steps.vp.outputs.pnpm": "pnpm@12.15.0",
  };
  const output = join(dir, "output");
  const pathFile = join(dir, "path");
  const envFile = join(dir, "env");
  const commands = join(dir, "commands");
  const env = {
    ...process.env,
    GITHUB_OUTPUT: output,
    GITHUB_PATH: pathFile,
    GITHUB_ENV: envFile,
    VP_HOME: root,
  };
  function executable(name, body) {
    writeFileSync(
      join(root, "bin", name),
      `#!${process.execPath}\n` +
        `require('node:fs').appendFileSync(${JSON.stringify(commands)}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n` +
        body,
      { mode: 0o755 },
    );
  }
  function install(options = {}) {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", ".vp-setup-complete"), "");
    executable("node", `console.log(${JSON.stringify(options.node || "v26.12.1")});`);
    executable("pnpm", `console.log(${JSON.stringify(options.pnpm || "12.15.0")});`);
    const state = {
      node: {
        version: "26.12.1",
        installed: true,
        mode: "managed",
        bin_path: join(root, "bin/node"),
      },
      package_manager: {
        name: "pnpm",
        version: "12.15.0",
        installed: true,
        mode: "managed",
        bin_paths: { pnpm: join(root, "bin/pnpm") },
      },
      ...options.state,
    };
    const stateFile = join(root, "state.json");
    if (options.lazyPnpm) {
      state.package_manager.installed = false;
      rmSync(join(root, "bin/pnpm"));
    }
    writeFileSync(stateFile, JSON.stringify(state));
    executable(
      "vp",
      `
const args = process.argv.slice(2).join(' ');
if (args === '--version') console.log(${JSON.stringify(options.vp || "vp v1.3.0")});
else if (args === 'env current --json') console.log(require('node:fs').readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
else if (args === 'env use 26.12.1') process.exit(${options.activationExit || 0});
else if (args === 'env use pnpm@12.15.0') {
  if (${options.pmInstallExit || 0}) process.exit(${options.pmInstallExit || 0});
  const fs = require('node:fs');
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  state.package_manager.installed = true;
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  fs.writeFileSync(${JSON.stringify(join(root, "bin/pnpm"))}, ${JSON.stringify(`#!${process.execPath}\nconsole.log('12.15.0');\n`)}, { mode: 0o755 });
}
else process.exit(91);
`,
    );
  }
  function run(name) {
    const { script } = step(name);
    assert.ok(script);
    return spawnSync(
      "bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        script.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, key) => {
          assert.ok(key in values, `Unknown action value: ${key}`);
          return values[key];
        }),
      ],
      { env, encoding: "utf8" },
    );
  }
  function pipeline(hit, fallback = () => install()) {
    const outputs = { "steps.vp_cache.outputs.cache-hit": String(hit) };
    const enabled = (condition) => {
      if (!condition) return true;
      const match = condition.match(/^([\w.-]+) (==|!=) '([^']+)'$/);
      assert.ok(match, `Unsupported action condition: ${condition}`);
      const equal = (outputs[match[1]] || "") === match[3];
      return match[2] === "==" ? equal : !equal;
    };
    if (enabled(step("Check cached Vite+").condition)) {
      const check = run("Check cached Vite+");
      assert.equal(check.status, 0, check.stderr);
      outputs["steps.vp_ready.outputs.usable"] = readFileSync(output, "utf8").trim().split("=")[1];
    }
    let setups = 0;
    if (enabled(step("Setup Vite+").condition)) {
      setups++;
      if (fallback() === false) return { setups, status: 77 };
    }
    if (enabled(step("Install pinned pnpm").condition)) {
      const installed = run("Install pinned pnpm");
      if (installed.status !== 0)
        return { setups, status: installed.status, stderr: installed.stderr };
    }
    const verified = run("Verify Vite+ installation");
    return { setups, status: verified.status, stderr: verified.stderr };
  }
  return { root, dir, values, run, install, pipeline, commands, output, pathFile, envFile };
}

test("reuses a working exact-version cache without installing", (t) => {
  const f = fixture(t);
  f.install();
  assert.deepEqual(f.pipeline(true), { setups: 0, status: 0, stderr: "" });
  assert.equal(
    readFileSync(f.commands, "utf8"),
    [
      "vp --version",
      "vp env current --json",
      "node --version",
      "pnpm --version",
      "vp env use 26.12.1",
      "vp --version",
      "vp env current --json",
      "node --version",
      "pnpm --version",
      "vp env use 26.12.1",
      "",
    ].join("\n"),
  );
  assert.equal(readFileSync(f.pathFile, "utf8"), `${f.root}/bin\n${f.root}/bin\n`);
});

for (const [name, prepare, hit] of [
  ["cache miss", () => {}, false],
  ["sparse restore with no executable", () => {}, true],
  [
    "incomplete setup",
    (f) => {
      f.install();
      rmSync(join(f.root, "bin/.vp-setup-complete"));
    },
    true,
  ],
  [
    "missing Node payload",
    (f) => {
      f.install();
      rmSync(join(f.root, "bin/node"));
    },
    true,
  ],
  ["wrong Node executable", (f) => f.install({ node: "v24.22.0" }), true],
  ["wrong pnpm executable", (f) => f.install({ pnpm: "12.14.0" }), true],
  ["wrong Vite+ version", (f) => f.install({ vp: "vp v1.2.0" }), true],
  ["activation failure", (f) => f.install({ activationExit: 42 }), true],
]) {
  test(`installs and verifies after ${name}`, (t) => {
    const f = fixture(t);
    prepare(f);
    assert.deepEqual(f.pipeline(hit), { setups: 1, status: 0, stderr: "" });
  });
}

test("a failed fallback stops the job", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    f.pipeline(true, () => false),
    { setups: 1, status: 77 },
  );
  assert.equal(existsSync(f.pathFile), false);
});

test("materializes project-selected pnpm after setup-vp activates only Node", (t) => {
  const f = fixture(t);
  const result = f.pipeline(false, () => f.install({ lazyPnpm: true }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.setups, 1);
  assert.ok(readFileSync(f.pathFile, "utf8").includes(`${f.root}/bin\n`));
});

test("a failed pnpm materialization stops the job", (t) => {
  const f = fixture(t);
  const result = f.pipeline(false, () => f.install({ lazyPnpm: true, pmInstallExit: 42 }));
  assert.equal(result.status, 42);
  assert.equal(existsSync(f.pathFile), false);
});

test("a fallback reporting success with incomplete tools still stops the job", (t) => {
  const f = fixture(t);
  const result = f.pipeline(true, () => {});
  assert.equal(result.setups, 1);
  assert.equal(result.status, 127);
  assert.equal(existsSync(f.pathFile), false);
});

test("resolves the runner's symlink before archiving the payload", (t) => {
  const f = fixture(t);
  f.install();
  const runner = join(f.dir, "runner");
  mkdirSync(runner);
  symlinkSync(f.root, join(runner, ".vite-plus"));
  const source = step("Resolve Vite+ version").script.replaceAll(
    "$HOME/.vite-plus",
    `${runner}/.vite-plus`,
  );
  const result = spawnSync("bash", ["-e", "-c", source], {
    cwd: resolve(__dirname, "../../.."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: f.output, GITHUB_ENV: f.envFile },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(f.output, "utf8").includes(`home=${f.root}\n`));
  assert.equal(readFileSync(f.envFile, "utf8"), `VP_HOME=${f.root}\n`);
  const cache = steps.find((text) => text.startsWith("    - name: Cache Vite+\n"));
  const pathValue = cache.match(/^        path: (.+)$/m)[1];
  const payload = pathValue.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, key) => f.values[key]);
  const archive = join(f.dir, "cache.tgz");
  const restored = join(f.dir, "restored");
  mkdirSync(restored);
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", payload, "."]).status, 0);
  assert.equal(spawnSync("tar", ["-xzf", archive, "-C", restored]).status, 0);
  assert.equal(
    readFileSync(join(restored, "bin/vp"), "utf8"),
    readFileSync(join(f.root, "bin/vp"), "utf8"),
  );
});
