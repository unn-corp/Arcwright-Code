import { Platform as HostProcessPlatform } from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import type { MaintenanceHost } from "./MaintenanceHost.ts";
import { runStorageWorker } from "./storageWorker.ts";

const mocks = vi.hoisted(() => ({
  isSea: vi.fn(() => false),
  spawn: vi.fn(),
}));
vi.mock("node:sea", () => ({ isSea: mocks.isSea }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

describe("storage worker invocation", () => {
  it("dispatches a SEA directly to the native maintenance verb", async () => {
    mocks.isSea.mockReturnValue(true);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 4321,
      stdout: new NodeEvents.EventEmitter(),
      stderr: new NodeEvents.EventEmitter(),
      stdin: { end: vi.fn() },
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child as unknown as NodeChildProcess.ChildProcess);
    const recordStorageChild = vi.fn().mockResolvedValue(undefined);
    const host = {
      mode: "active",
      home: "/fixture/home",
      participantId: "fixture-backend",
      store: { directory: "/fixture/coordinator", recordStorageChild },
    } as unknown as Extract<MaintenanceHost, { mode: "active" }>;
    const pending = runStorageWorker(host, "fixture-transaction", "/fixture/bin.ts");
    child.emit("spawn");
    await Promise.resolve();
    child.emit("close", 0);
    await pending;

    const linux = HostProcessPlatform.defaultValue() === "linux";
    const [executable, arguments_, options] = mocks.spawn.mock.calls[0]!;
    expect(executable).toBe(linux ? "/usr/bin/ionice" : process.execPath);
    expect(arguments_).toEqual([
      ...(linux ? ["-c", "3", "/usr/bin/nice", "-n", "19", process.execPath] : []),
      "maintenance",
      "home",
      "normalize-storage",
      "--home",
      host.home,
      "--transaction",
      "fixture-transaction",
      "--parent-participant",
      host.participantId,
    ]);
    // Assert only the owned fields: a failure must never dump inherited credentials.
    expect(options.env.T3CODE_HOME).toBe(host.home);
    expect(options.env.T3CODE_MAINTENANCE_NAMESPACE).toBe(host.store.directory);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
    expect(recordStorageChild).toHaveBeenCalledWith(host.participantId, child.pid);
    expect(child.stdin.end).toHaveBeenCalledWith("storage-child-recorded\n");
  });
});
