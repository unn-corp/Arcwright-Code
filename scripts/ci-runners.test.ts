// @effect-diagnostics nodeBuiltinImport:off - these tests inspect GitHub's workflow configuration.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const yaml = NodeModule.createRequire(NodePath.join(root, "packages/shared/package.json"))(
  "yaml",
) as { parse(text: string): unknown };

interface Job {
  if?: string;
  needs?: string | string[];
  "runs-on"?: unknown;
  uses?: string;
  with?: Record<string, unknown>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Array<{ name?: string; run?: string; env?: Record<string, unknown> }>;
}
interface Workflow {
  on?: { workflow_call?: unknown };
  jobs: Record<string, Job>;
}
const requiredLabels = ["self-hosted", "unn", "unn-isolated", "t3-ci"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Inspect every branch of a conditional fromJSON matrix, including branches a
// particular workflow dispatch does not select. No GitHub expression is executed.
function matrixValues(value: unknown, fixedSelector = false): unknown[] {
  if (Array.isArray(value)) return value;
  // Reservation and PR-number outputs cannot change a static runs-on array.
  // Leave unrelated runtime rows opaque; never do this for a matrix selector.
  if (
    fixedSelector &&
    typeof value === "string" &&
    /^\$\{\{\s*fromJSON\(needs\.[\w.-]+\.outputs\.[\w]+\)\s*\}\}$/i.test(value)
  )
    return [{}];
  if (typeof value !== "string" || !/^\$\{\{\s*fromJSON\(/i.test(value)) {
    throw new Error("Runner matrices must use explicit choices or literal JSON");
  }
  const choices: unknown[] = [];
  for (const match of value.matchAll(/'((?:[^']|'')*)'/g)) {
    const literal = match[1]!.replaceAll("''", "'").trim();
    if (!literal.startsWith("[")) continue;
    const parsed: unknown = JSON.parse(literal);
    if (!Array.isArray(parsed)) throw new Error("Matrix JSON must be an array");
    choices.push(...parsed);
  }
  if (choices.length === 0) throw new Error("Matrix has no literal JSON choices");
  return choices;
}

function matrixContexts(matrix: Record<string, unknown> | undefined, selector: unknown) {
  if (matrix === undefined) return [{}];
  const fixedSelector =
    Array.isArray(selector) &&
    selector.every((label) => typeof label === "string" && !label.includes("${{"));
  let contexts: Record<string, unknown>[] = [{}];
  let hasAxes = false;
  for (const [axis, value] of Object.entries(matrix)) {
    if (axis === "include" || axis === "exclude") continue;
    hasAxes = true;
    contexts = contexts.flatMap((context) =>
      matrixValues(value, fixedSelector).map((choice) => ({ ...context, [axis]: choice })),
    );
  }
  const include = matrix.include === undefined ? [] : matrixValues(matrix.include, fixedSelector);
  for (const entry of include) {
    if (!record(entry)) throw new Error("Matrix include choices must be objects");
  }
  // Checking excluded combinations is conservative: excluding a platform must
  // never hide a hosted fallback waiting to be enabled later.
  return [...(hasAxes || include.length === 0 ? contexts : []), ...include.filter(record)];
}

function resolve(
  value: unknown,
  matrix: Record<string, unknown>,
  inputs: Record<string, unknown>,
): unknown {
  if (typeof value !== "string" || !value.includes("${{")) return value;
  const match = /^\$\{\{\s*(matrix|inputs)\.([\w.]+)\s*\}\}$/.exec(value);
  if (!match) throw new Error(`Unverifiable runner expression: ${value}`);
  let resolved: unknown = match[1] === "matrix" ? matrix : inputs;
  for (const key of match[2]!.split(".")) {
    if (!record(resolved)) throw new Error(`Missing runner choice: ${value}`);
    resolved = resolved[key];
  }
  if (resolved === undefined) throw new Error(`Missing runner choice: ${value}`);
  return resolved;
}

function verifyRunners(workflows: Record<string, Workflow>) {
  const inspected = new Set<string>();
  const inspect = (file: string, inputs: Record<string, unknown>, stack: string[]) => {
    if (stack.includes(file)) throw new Error("Reusable workflow cycle");
    const workflow = workflows[file];
    if (!workflow) throw new Error(`Unknown reusable workflow: ${file}`);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      inspected.add(`${file}/${name}`);
      for (const matrix of matrixContexts(job.strategy?.matrix, job["runs-on"])) {
        if (job.uses !== undefined) {
          const called = /^\.\/\.github\/workflows\/(.+)$/.exec(job.uses);
          if (!called) throw new Error(`Unverifiable reusable workflow: ${job.uses}`);
          const given = Object.fromEntries(
            Object.entries(job.with ?? {}).map(([key, value]) => [
              key,
              key === "runner" || key === "runner_arch" ? resolve(value, matrix, inputs) : value,
            ]),
          );
          inspect(called[1]!, given, [...stack, file]);
          continue;
        }
        if (!Array.isArray(job["runs-on"]))
          throw new Error(`${file}/${name}: labels must be an array`);
        for (const label of requiredLabels) {
          if (!job["runs-on"].includes(label)) throw new Error(`${file}/${name}: missing ${label}`);
        }
        const labels = job["runs-on"].map((label) => {
          const resolved = resolve(label, matrix, inputs);
          if (typeof resolved !== "string") throw new Error("Runner labels must be strings");
          return resolved.toLowerCase();
        });
        const operatingSystems = labels.filter((label) =>
          ["linux", "windows", "macos"].includes(label),
        );
        const architectures = labels.filter((label) => ["x64", "arm64"].includes(label));
        if (operatingSystems.length !== 1 || architectures.length !== 1) {
          throw new Error(`${file}/${name}: runner needs one native OS and architecture`);
        }
        const target =
          matrix.target ?? (record(matrix.platform) ? matrix.platform.target : undefined);
        if (typeof target === "string") {
          const expected = target === "android" ? ["linux", "x64"] : target.split("-");
          if (
            expected.length !== 2 ||
            operatingSystems[0] !== expected[0] ||
            architectures[0] !== expected[1]
          ) {
            throw new Error(`${file}/${name}: runner cannot execute ${target}`);
          }
        }
        if (typeof inputs.platform === "string" && typeof inputs.arch === "string") {
          const expectedOS =
            inputs.platform === "win"
              ? "windows"
              : inputs.platform === "mac"
                ? "macos"
                : inputs.platform;
          // The Intel macOS DMG is packaged on Apple Silicon without an Intel
          // CLI archive; native CLI smoke tests still require matching hardware.
          const crossPackagedMac =
            inputs.platform === "mac" &&
            inputs.arch === "x64" &&
            inputs.cli_archive === false &&
            architectures[0] === "arm64";
          if (
            operatingSystems[0] !== expectedOS ||
            (architectures[0] !== inputs.arch && !crossPackagedMac)
          ) {
            throw new Error(`${file}/${name}: runner does not match desktop target`);
          }
        }
      }
    }
  };
  for (const [file, workflow] of Object.entries(workflows)) {
    if (workflow.on?.workflow_call === undefined) inspect(file, {}, []);
  }
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const name of Object.keys(workflow.jobs)) {
      if (!inspected.has(`${file}/${name}`))
        throw new Error(`Unverified reusable workflow: ${file}/${name}`);
    }
  }
}

const labels = (os = "linux", arch = "x64") => [
  "self-hosted",
  os,
  arch,
  "unn",
  "unn-isolated",
  "t3-ci",
];
function loadWorkflows(): Record<string, Workflow> {
  const directory = NodePath.join(root, ".github/workflows");
  return Object.fromEntries(
    NodeFS.readdirSync(directory)
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [
        file,
        yaml.parse(NodeFS.readFileSync(NodePath.join(directory, file), "utf8")) as Workflow,
      ]),
  );
}

// These repository guards use boolean/equality operators shared with JavaScript.
// Supply successful prerequisites so dependency skipping cannot conceal a missing guard.
function admitsJob(
  job: Job,
  repository: string,
  inputs: Record<string, unknown> = { platform: "all" },
  eventName = "push",
): boolean {
  if (job.if === undefined) return true;
  const names = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  const needs = Object.fromEntries(
    names.map((name) => [
      name,
      {
        result: "success",
        outputs: { eligible: "true", changed: "true", skip: "false" },
      },
    ]),
  );
  const expression = job.if.replace(/^\s*\$\{\{([\s\S]*?)\}\}\s*$/, "$1");
  const result: unknown = NodeVM.runInNewContext(
    expression,
    {
      github: {
        repository,
        event_name: eventName,
        event: {
          action: "closed",
          label: { name: "preview:mac" },
          pull_request: { draft: false },
          workflow_run: { event: "pull_request", conclusion: "success" },
        },
      },
      inputs,
      needs,
      always: () => true,
      cancelled: () => false,
      failure: () => false,
      success: () => true,
    },
    { timeout: 1000 },
  );
  if (typeof result !== "boolean") throw new Error("Job guard did not produce a boolean");
  return result;
}

describe("organization self-hosted CI policy", () => {
  it("checks every checked-in workflow and every reusable caller", () => {
    const workflows = loadWorkflows();
    verifyRunners(workflows);
    for (const [file, name, os, arch] of [
      ["ci.yml", "mobile_native_static_analysis", "macOS", "arm64"],
      ["mobile-showcase-screenshots.yml", "ios", "macOS", "arm64"],
      ["mobile-showcase-screenshots.yml", "android", "linux", "x64"],
      ["windows-tests.yml", "test", "windows", "x64"],
    ]) {
      expect(workflows[file!]!.jobs[name!]!["runs-on"]).toEqual(labels(os, arch));
    }
  });

  it("rejects hosted selectors and missing fleet or isolation labels", () => {
    for (const selection of [
      "ubuntu-latest",
      labels().filter((label) => label !== "self-hosted"),
      labels().filter((label) => label !== "unn"),
      labels().filter((label) => label !== "unn-isolated"),
      labels().filter((label) => label !== "t3-ci"),
    ]) {
      expect(() =>
        verifyRunners({ "ci.yml": { jobs: { test: { "runs-on": selection } } } }),
      ).toThrow();
    }
    verifyRunners({ "ci.yml": { jobs: { test: { "runs-on": labels() } } } });
  });

  it("checks native targets in static and conditional JSON matrices", () => {
    const workflow = (platform: unknown): Workflow => ({
      jobs: {
        test: {
          "runs-on": labels("${{ matrix.platform.runner }}"),
          strategy: { matrix: { platform } },
        },
      },
    });
    const platforms = [
      { target: "linux-x64", runner: "linux" },
      { target: "windows-x64", runner: "windows" },
    ];
    verifyRunners({ "ci.yml": workflow(platforms) });
    verifyRunners({
      "ci.yml": workflow(
        `\${{ fromJSON(inputs.scope == 'host-runtime' && '${JSON.stringify(platforms)}' || '[{"target":"windows-x64","runner":"windows"}]') }}`,
      ),
    });
    expect(() =>
      verifyRunners({
        "ci.yml": workflow(
          `\${{ fromJSON(inputs.scope == 'host-runtime' && '${JSON.stringify(platforms)}' || '[{"target":"windows-x64","runner":"ubuntu-latest"}]') }}`,
        ),
      }),
    ).toThrow();
    expect(() =>
      verifyRunners({ "ci.yml": workflow([{ target: "windows-x64", runner: "linux" }]) }),
    ).toThrow(/cannot execute/);
    const outputRows = "${{ fromJSON(needs.reserve.outputs.matrix) }}";
    verifyRunners({
      "ci.yml": {
        jobs: {
          recovery: {
            "runs-on": labels(),
            strategy: { matrix: { include: outputRows } },
          },
        },
      },
    });
    expect(() =>
      verifyRunners({
        "ci.yml": {
          jobs: {
            recovery: {
              "runs-on": labels("${{ matrix.runner }}"),
              strategy: { matrix: { include: outputRows } },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("checks matrix axes, include entries, and reusable input substitutions", () => {
    verifyRunners({
      "ci.yml": {
        jobs: {
          docs: {
            "runs-on": labels("${{ matrix.os }}"),
            strategy: { matrix: { os: ["linux", "windows"] } },
          },
          smoke: {
            "runs-on": labels("${{ matrix.runner }}"),
            strategy: {
              matrix: {
                include: [
                  { target: "linux-x64", runner: "linux" },
                  { target: "windows-x64", runner: "windows" },
                ],
              },
            },
          },
        },
      },
    });
    const called: Workflow = {
      on: { workflow_call: {} },
      jobs: { build: { "runs-on": labels("${{ inputs.runner }}", "${{ inputs.runner_arch }}") } },
    };
    const caller = (runner: string, runner_arch = "arm64"): Workflow => ({
      jobs: {
        package: {
          uses: "./.github/workflows/desktop.yml",
          with: { runner, runner_arch, platform: "win", arch: "arm64" },
        },
      },
    });
    verifyRunners({ "desktop.yml": called, "ci.yml": caller("windows") });
    expect(() =>
      verifyRunners({ "desktop.yml": called, "ci.yml": caller("windows-2025") }),
    ).toThrow();
    expect(() =>
      verifyRunners({ "desktop.yml": called, "ci.yml": caller("windows", "x64") }),
    ).toThrow(/desktop target/);
  });
});

describe("fork CI platform capacity", () => {
  it("explicitly excludes every macOS or hardware ARM64 caller on the fork", () => {
    const workflows = loadWorkflows();
    const unsupported: string[] = [];
    for (const [file, workflow] of Object.entries(workflows)) {
      if (workflow.on?.workflow_call !== undefined) continue;
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const selection =
          job.uses === "./.github/workflows/release-desktop.yml"
            ? labels(String(job.with?.runner), String(job.with?.runner_arch))
            : job["runs-on"];
        if (!Array.isArray(selection)) continue;
        for (const matrix of matrixContexts(job.strategy?.matrix, selection)) {
          const host = new Set(
            selection.map((label) => String(resolve(label, matrix, {})).toLowerCase()),
          );
          if (!host.has("macos") && !host.has("arm64")) continue;
          unsupported.push(`${file}/${name}`);
          expect(admitsJob(job, "unn-corp/Arcwright-Code", job.with)).toBe(false);
          expect(admitsJob(job, "pingdotgg/t3code", job.with)).toBe(true);
        }
      }
    }
    expect(unsupported).toContain("ci.yml/mobile_native_static_analysis");
    expect(unsupported).toContain("mobile-showcase-screenshots.yml/ios");
    expect(unsupported).toContain("release.yml/desktop_linux_arm64");
    expect(unsupported).toContain("release.yml/desktop_win_arm64");
  });

  it("disables the native detector and every macOS preview stage without altering upstream", () => {
    const workflows = loadWorkflows();
    // Upstream consolidated native change detection into the shared changes job.
    const analysis = workflows["ci.yml"]!.jobs.mobile_native_static_analysis!;
    expect(admitsJob(analysis, "unn-corp/Arcwright-Code")).toBe(false);
    expect(admitsJob(analysis, "pingdotgg/t3code")).toBe(true);
    for (const [file, workflow] of Object.entries(workflows)) {
      if (!file.startsWith("desktop-macos-preview")) continue;
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const event = name === "cleanup" ? "pull_request_target" : "workflow_run";
        expect(admitsJob(job, "unn-corp/Arcwright-Code", {}, event)).toBe(false);
        expect(admitsJob(job, "pingdotgg/t3code", {}, event)).toBe(true);
      }
    }
  });

  it("enforces fork capacity in the reusable desktop callee even for contradictory inputs", () => {
    const build = loadWorkflows()["release-desktop.yml"]!.jobs.build!;
    for (const [runner, runner_arch, platform, arch] of [
      ["macOS", "arm64", "mac", "arm64"],
      ["macOS", "x64", "mac", "x64"],
      ["linux", "arm64", "linux", "arm64"],
      ["windows", "arm64", "win", "arm64"],
      ["linux", "x64", "linux", "arm64"],
      ["linux", "arm64", "linux", "x64"],
      ["windows", "x64", "mac", "x64"],
    ]) {
      const inputs = { runner, runner_arch, platform, arch };
      expect(admitsJob(build, "unn-corp/Arcwright-Code", inputs)).toBe(false);
      expect(admitsJob(build, "pingdotgg/t3code", inputs)).toBe(true);
    }
    for (const [runner, platform] of [
      ["linux", "linux"],
      ["windows", "win"],
    ]) {
      expect(
        admitsJob(build, "unn-corp/Arcwright-Code", {
          runner,
          runner_arch: "x64",
          platform,
          arch: "x64",
        }),
      ).toBe(true);
    }
  });

  it("keeps Linux/Windows x64 releases and Android jobs enabled, including ARM64 APK output", () => {
    const workflows = loadWorkflows();
    for (const file of ["fork-release.yml", "fork-baseline.yml"]) {
      for (const name of ["desktop_linux_x64", "desktop_win_x64", "android"]) {
        expect(admitsJob(workflows[file]!.jobs[name]!, "unn-corp/Arcwright-Code")).toBe(true);
      }
    }
    expect(
      admitsJob(
        workflows["mobile-showcase-screenshots.yml"]!.jobs.android!,
        "unn-corp/Arcwright-Code",
      ),
    ).toBe(true);
    const android: Job = {
      "runs-on": labels(),
      strategy: { matrix: { apk_abi: ["arm64-v8a", "armeabi-v7a", "x86_64"] } },
    };
    verifyRunners({ "android.yml": { jobs: { apk: android } } });
    expect(admitsJob(android, "unn-corp/Arcwright-Code")).toBe(true);
  });

  it("uses preinstalled browser OS libraries instead of privileged runtime installation", () => {
    for (const [file, workflow] of Object.entries(loadWorkflows())) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        for (const step of job.steps ?? []) {
          if (!step.run?.includes("playwright")) continue;
          expect(
            step.run,
            `${file}/${name}: browser OS dependencies belong in the image`,
          ).not.toContain("--with-deps");
        }
      }
    }
  });

  it("runs Check's actual gate and permits only intentional skipped jobs", () => {
    const check = loadWorkflows()["ci.yml"]!.jobs.check!;
    const gate = check.steps?.find((step) => step.name === "Require every job to pass");
    if (gate?.run === undefined || !Array.isArray(check.needs))
      throw new Error("Missing Check gate");
    const initial = Object.fromEntries(check.needs.map((name) => [name, { result: "success" }]));
    const disabled = new Set(["mobile_native_static_analysis"]);
    const fork = {
      ...initial,
      ...Object.fromEntries([...disabled].map((name) => [name, { result: "skipped" }])),
    };
    const runGate = (
      repository: string,
      states: Record<string, { result: string; outputs?: Record<string, string> }>,
    ) => {
      const env = { ...process.env };
      delete env.REPOSITORY;
      delete env.RESULTS;
      for (const [key, value] of Object.entries(gate.env ?? {})) {
        if (value === "${{ github.repository }}") env[key] = repository;
        else if (value === "${{ toJSON(needs) }}") env[key] = JSON.stringify(states);
        else throw new Error(`Unsupported Check environment expression: ${key}`);
      }
      return NodeChildProcess.spawnSync("bash", ["-e", "-o", "pipefail", "-c", gate.run!], {
        env,
        encoding: "utf8",
      });
    };
    const admitted = runGate("unn-corp/Arcwright-Code", fork);
    expect(admitted.error).toBeUndefined();
    expect(admitted.status, admitted.stderr).toBe(0);
    for (const name of check.needs) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        if (result === "skipped" && disabled.has(name)) continue;
        expect(runGate("unn-corp/Arcwright-Code", { ...fork, [name]: { result } }).status).not.toBe(
          0,
        );
      }
    }
    expect(runGate("pingdotgg/t3code", fork).status).not.toBe(0);
    expect(
      runGate("pingdotgg/t3code", {
        ...initial,
        changes: { result: "success", outputs: { mobile_native: "false" } },
        mobile_native_static_analysis: { result: "skipped" },
      }).status,
    ).toBe(0);
  });
});
