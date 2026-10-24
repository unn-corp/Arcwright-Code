// @effect-diagnostics nodeBuiltinImport:off -- Owned native Git/worktree fixtures verify real remote changes without accessing user repositories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import {
  buildProjectUxPolicy,
  normalizeUxOrigin,
  projectUxContext,
  readUxOrigin,
} from "./ProjectUxPolicy.ts";
import { unnUxCore } from "./policies/unnUxCore.ts";

describe("project UX policy", () => {
  it.each([
    "https://github.com/unn-corp/Example.git",
    "git@github.com:unn-corp/Example.git",
    "ssh://git@github.com/UNN-CORP/Example",
    "ssh://git@github.com:22/UNN-CORP/Example.git",
    "https://github.com:443/unn-corp/Example.git/",
  ])("normalizes %s", (remote) => {
    expect(normalizeUxOrigin(remote)).toBe("github.com/unn-corp/example");
  });
  it.each([
    "https://github.com.evil.test/unn-corp/example",
    "https://github.com@evil.test/unn-corp/example",
    "https://evil.test/github.com/unn-corp/example",
    "https://github.com/unn-corp-lookalike/example",
    "ssh://git@github.com:2222/unn-corp/example",
    "https://github.com/unn-corp%2fexample",
    "https://github.com/unn-corp/example?other=1",
    "https://github.com/unn-corp/../example",
  ])("does not automatically enable %s", (remote) => {
    const p = buildProjectUxPolicy({ projectId: "a", origin: normalizeUxOrigin(remote) });
    expect(p.text).toContain("No application UX guidance");
  });
  it("pins the exact reviewed source, retaining all 19 bounded principles", async () => {
    const source = await NodeFSP.readFile(
      new URL("./policies/UNNDEV-UI-STANDARDS-CORE.md", import.meta.url),
      "utf8",
    );
    expect(unnUxCore).toBe(source);
    const p = buildProjectUxPolicy({ projectId: "a", origin: "github.com/unn-corp/example" });
    expect(p.text).toContain("Occam's razor");
    expect(p.text).toContain("Backend-only");
    expect(p.text).toContain("delegated UX work");
    expect(p.text).toContain("User task success, accessibility, security");
  });
  it("supports explicit client/non-Git opt-in and UNN opt-out without leakage", () => {
    for (const origin of [null, "github.com/client/example", "github.com/unn-corp/example"]) {
      expect(buildProjectUxPolicy({ projectId: "a", origin, mode: "on" }).text).toContain(
        "19 principles",
      );
      expect(buildProjectUxPolicy({ projectId: "b", origin, mode: "off" }).text).toContain(
        "inactive",
      );
    }
    expect(buildProjectUxPolicy({ projectId: "c", origin: null }).text).toContain("inactive");
  });
  it("refuses missing or hash-mismatched bundled policy", () => {
    for (const core of ["", unnUxCore + "changed"]) {
      expect(
        buildProjectUxPolicy({ projectId: "a", origin: null, mode: "on", core }).text,
      ).toContain("inactive");
    }
  });
  it("caps UTF-8 bytes, preserves lexical order and overwrites every policy key on opt-out", () => {
    const text = "é🙂".repeat(3000);
    const context = projectUxContext({ projectId: "a", text });
    expect(
      Object.values(context)
        .map((entry) => entry.value)
        .join(""),
    ).toBe(text);
    expect(Object.keys(context)).toEqual(Object.keys(context).toSorted());
    for (const entry of Object.values(context))
      expect(Buffer.byteLength(entry.value)).toBeLessThanOrEqual(6000);
    const off = projectUxContext(buildProjectUxPolicy({ projectId: "b", origin: null }));
    expect(Object.keys(off)).toEqual(Object.keys(context));
    expect(
      Object.values(off)
        .map((entry) => entry.value)
        .join(""),
    ).not.toContain("é");
    expect(() => projectUxContext({ projectId: "a", text: "x".repeat(24001) })).toThrow();
  });
  it("reads origin rather than upstream, refreshes changed remotes and supports worktrees", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ux-origin-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    try {
      expect(await readUxOrigin(root)).toBeNull();
      git("init");
      const nested = NodePath.join(root, "non-git-project");
      await NodeFSP.mkdir(nested);
      expect(await readUxOrigin(root)).toBeNull();
      git("remote", "add", "origin", "https://github.com/unn-corp/example.git");
      git("remote", "add", "upstream", "https://github.com/client/example.git");
      expect(await readUxOrigin(root)).toBe("github.com/unn-corp/example");
      expect(await readUxOrigin(nested)).toBeNull();
      git("remote", "set-url", "origin", "git@github.com:client/example.git");
      git("remote", "set-url", "upstream", "git@github.com:unn-corp/example.git");
      expect(await readUxOrigin(root)).toBe("github.com/client/example");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      );
      const worktree = NodePath.join(root, "worktree");
      git("worktree", "add", worktree);
      expect(await readUxOrigin(worktree)).toBe("github.com/client/example");
      git("remote", "set-url", "origin", "ssh://git@github.com/unn-corp/example.git");
      expect(await readUxOrigin(worktree)).toBe("github.com/unn-corp/example");
      git("config", "--add", "remote.origin.url", "https://github.com/client/other.git");
      expect(await readUxOrigin(worktree)).toBeNull();
      git("remote", "remove", "origin");
      expect(await readUxOrigin(worktree)).toBeNull();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
