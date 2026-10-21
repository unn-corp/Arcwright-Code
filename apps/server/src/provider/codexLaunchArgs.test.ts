import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexSessionAppServerArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codexSessionAppServerArgs", () => {
  it("pins full-access sessions to non-interactive, unrestricted Codex config", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1"],
        "",
        "full-access",
      ),
      [
        "app-server",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
      ],
    );
  });

  it("pins automated reviews to non-interactive, read-only Codex config", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(undefined, undefined, "automated-review"),
      ["app-server", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"'],
    );
  });

  it("does not override restricted runtime modes", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(undefined, "", "approval-required"), [
      "app-server",
    ]);
  });
});
