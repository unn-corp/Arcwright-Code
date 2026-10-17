// @effect-diagnostics nodeBuiltinImport:off processEnv:off
/** The normal packaged CLI performs maintenance in a separate process before this backend opens its database. */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";
import type { MaintenanceHost } from "./MaintenanceHost.ts";

export function runStorageWorker(
  host: Extract<MaintenanceHost, { mode: "active" }>,
  transactionId: string,
  entry = process.argv[1],
): Promise<void> {
  if (entry === undefined)
    return Promise.reject(new Error("The packaged maintenance CLI entry is unavailable."));
  return new Promise((resolve, reject) => {
    // Set Linux I/O priority before Node creates its filesystem threads. These utilities exec in the captured PID.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- native spawn boundary configures this actual child process's kernel priorities
    const linux = NodeOS.platform() === "linux";
    const executable = linux ? "/usr/bin/ionice" : process.execPath;
    const prefix = linux ? ["-c", "3", "/usr/bin/nice", "-n", "19", process.execPath] : [];
    const child = NodeChildProcess.spawn(
      executable,
      [
        ...prefix,
        ...(NodeSea.isSea() ? [] : [entry]),
        "maintenance",
        "home",
        "optimize-storage",
        "--home",
        host.home,
        "--transaction",
        transactionId,
        "--parent-participant",
        host.participantId,
      ],
      {
        env: {
          ...process.env,
          T3CODE_HOME: host.home,
          T3CODE_MAINTENANCE_NAMESPACE: host.store.directory,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "",
      errors = "";
    let registrationError: unknown;
    child.once("spawn", () => {
      host.store.recordStorageChild(host.participantId, child.pid!).then(
        () => {
          child.stdin.end("storage-child-recorded\n");
        },
        (cause) => {
          registrationError = cause;
          // This is the exact child captured above, and it has not been admitted to touch data yet.
          child.kill();
        },
      );
    });
    child.stdout.on("data", (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-64 * 1024);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      errors = (errors + bytes.toString()).slice(-4096);
    });
    child.once("error", reject);
    // Await actual process exit even on failure: recovery must never race a still-running optimizer.
    child.once("close", (code) => {
      if (registrationError !== undefined) reject(registrationError);
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `Storage optimization did not complete (${code ?? "signal"}): ${output || errors}`,
          ),
        );
    });
  });
}
