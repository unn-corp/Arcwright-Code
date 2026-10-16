// @effect-diagnostics nodeBuiltinImport:off -- Exercise helper-process lifetime with real IPC and fixture modules.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ContentSearchProcess } from "./ContentSearchProcess.ts";

it("rejects pending and future calls after a native helper crash and disposes it", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-content-crash-"));
  const modulePath = NodePath.join(directory, "finder.cjs");
  await NodeFSP.writeFile(
    modulePath,
    `exports.FileFinder = { create() { return { ok: true, value: {
    grep() { process.exit(17); }, waitForIndexReady() { return { ok: true, value: true }; }
  } }; } };`,
  );
  const helper = new ContentSearchProcess(modulePath);
  try {
    await expect(helper.create({ basePath: directory })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(helper.grep("needle")).rejects.toThrow("Content search process exited (17)");
    await expect(helper.grep("needle")).rejects.toThrow("Content search process exited (17)");
  } finally {
    await helper.destroy();
    await helper.destroy();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("reports native initialization failures without leaking its helper process", async () => {
  const helper = new ContentSearchProcess("/unavailable/fff-module.cjs");
  try {
    await expect(helper.create({ basePath: "/workspace" })).rejects.toThrow();
  } finally {
    await helper.destroy();
  }
  await expect(helper.grep("needle")).rejects.toThrow("disposed");
});

it("disposes an active request even when the native helper ignores SIGTERM", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-content-dispose-"));
  const modulePath = NodePath.join(directory, "finder.cjs");
  await NodeFSP.writeFile(
    modulePath,
    `exports.FileFinder = { create(options) {
    process.on('SIGTERM', () => {});
    return { ok: true, value: { grep() {
      require('node:fs').writeFileSync(require('node:path').join(options.basePath, 'active'), 'ready');
      return new Promise(() => {});
    } } };
  } };`,
  );
  const helper = new ContentSearchProcess(modulePath);
  const watcher = NodeFS.watch(directory);
  try {
    await helper.create({ basePath: directory });
    const started = new Promise<void>((resolve) => {
      watcher.on("change", (_event, filename) => {
        if (filename === "active") resolve();
      });
    });
    const rejected = expect(helper.grep("needle")).rejects.toThrow("disposed");
    await started;
    await helper.destroy();
    await rejected;
  } finally {
    watcher.close();
    await helper.destroy();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
