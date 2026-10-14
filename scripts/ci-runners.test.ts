// @effect-diagnostics nodeBuiltinImport:off - these tests inspect GitHub's workflow configuration.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const yaml = NodeModule.createRequire(NodePath.join(root, "packages/shared/package.json"))(
  "yaml",
) as { parse(text: string): unknown };

interface Job {
  "runs-on"?: unknown;
  uses?: string;
  with?: Record<string, unknown>;
  strategy?: { matrix?: Record<string, unknown> };
}
interface Workflow {
  on?: { workflow_call?: unknown };
  jobs: Record<string, Job>;
}
const requiredLabels = ["self-hosted", "unn", "unn-isolated"];
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

const labels = (os = "linux", arch = "x64") => ["self-hosted", os, arch, "unn", "unn-isolated"];
describe("organization self-hosted CI policy", () => {
  it("checks every checked-in workflow and every reusable caller", () => {
    const directory = NodePath.join(root, ".github/workflows");
    const workflows = Object.fromEntries(
      NodeFS.readdirSync(directory)
        .filter((file) => /\.ya?ml$/.test(file))
        .map((file) => [
          file,
          yaml.parse(NodeFS.readFileSync(NodePath.join(directory, file), "utf8")) as Workflow,
        ]),
    );
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
