// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - These fixtures check real systemd cgroup and namespace boundaries.
import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import {
  allocateOrganizationScopedUnitName,
  isOrganizationScopedSandboxAvailable,
  prepareOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";

const available = isOrganizationScopedSandboxAvailable();
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

async function waitForCgroupFile(
  path: string,
  condition: (contents: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const read = async () => {
    try {
      return await NodeFSP.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const initial = await read();
  if (initial === null || condition(initial)) return;
  const watcher = NodeFSP.watch(path, { signal: AbortSignal.timeout(timeoutMs) });
  try {
    const current = await read();
    if (current === null || condition(current)) return;
    try {
      for await (const _ of watcher) {
        const contents = await read();
        if (contents === null || condition(contents)) return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).name !== "AbortError") throw error;
    }
  } finally {
    await watcher.return?.();
  }
  const final = await read();
  if (final !== null && !condition(final))
    throw new Error(`Timed out waiting for cgroup state in ${path}`);
}

it("rejects malformed reserved unit names before a host launch", async () => {
  await NodeAssert.strict.rejects(
    prepareOrganizationScopedSandbox({
      argv: ["/usr/bin/true"],
      reservedUnitName: "../../user.service",
    }),
    /Reserved scope unit name is invalid/,
  );
});

it.skipIf(!available)("uses an exact preallocated systemd unit name", async () => {
  const reservedUnitName = allocateOrganizationScopedUnitName();
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/true"],
    reservedUnitName,
  });
  NodeAssert.strict.equal(handle.unitName, reservedUnitName);
  await handle.discard();
});

it.skipIf(!available)("prepares a verified scoped sandbox before caller code starts", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('SCOPED_EXECUTED\\n')"],
    runtimeMs: 3_000,
  });
  NodeAssert.strict.match(handle.unitName, /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
  NodeAssert.strict.match(handle.invocationId, /^[a-f0-9]{32}$/);
  NodeAssert.strict.ok(handle.controlGroup.endsWith(`/${handle.unitName}`));
  NodeAssert.strict.equal(
    (await NodeFSP.readFile(`/sys/fs/cgroup${handle.controlGroup}/memory.swap.max`, "utf8")).trim(),
    "0",
  );
  await NodeAssert.strict.rejects(handle.wait(), /has not started/);
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(result.stdout, /SCOPED_EXECUTED/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("forwards unlinked FD6+ input as read-only staged data", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "const f=require('node:fs');process.stdout.write('STAGED='+f.readFileSync('/workspace/data.txt','utf8')+'\\n');try{f.writeFileSync('/workspace/data.txt','tampered');process.stdout.write('WRITABLE\\n')}catch(e){process.stdout.write('WRITE_DENIED='+e.code+'\\n')}",
    ],
    files: { "data.txt": "synthetic-stage-proof" },
  });
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(result.stdout, /STAGED=synthetic-stage-proof/);
  NodeAssert.strict.match(result.stdout, /WRITE_DENIED=(EROFS|EBUSY)/);
  NodeAssert.strict.doesNotMatch(result.stdout, /WRITABLE/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("supervisor SIGKILL leaves no staged host input", async () => {
  const moduleUrl = new URL("./OrganizationScopedSandboxHost.ts", import.meta.url).href;
  const script = `
    import { prepareOrganizationScopedSandbox } from ${JSON.stringify(moduleUrl)};
    const handle = await prepareOrganizationScopedSandbox({
      argv: ['/usr/bin/node', '-e', 'setInterval(() => {}, 1000)'],
      files: { 'synthetic.txt': 'synthetic-stage-proof' },
      runtimeMs: 1_000,
    });
    process.stdout.write(JSON.stringify({unitName: handle.unitName, controlGroup: handle.controlGroup, workDirectory: handle.workDirectory}) + '\\n');
    await handle.start();
    process.stdout.write('STARTED\\n');
    setInterval(() => {}, 1000);
  `;
  const supervisor = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  let text = "";
  let unitName = "";
  let controlGroup = "";
  let workDirectory = "";
  try {
    await new Promise<void>((resolve, reject) => {
      supervisor.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const line = text.split("\n")[0];
        if (line && !unitName) {
          try {
            const value = JSON.parse(line) as {
              unitName: string;
              controlGroup: string;
              workDirectory: string;
            };
            unitName = value.unitName;
            controlGroup = value.controlGroup;
            workDirectory = value.workDirectory;
          } catch {
            /* wait for complete JSON line */
          }
        }
        if (text.includes("STARTED\n")) {
          resolve();
        }
      });
      supervisor.once("error", (error) => {
        reject(error);
      });
      supervisor.once("close", (code) => {
        if (!text.includes("STARTED\n")) {
          reject(new Error(`Crash probe exited ${code}: ${text}`));
        }
      });
    });
    NodeAssert.strict.match(unitName, /^t3-org-sandbox-[a-f0-9]{32}\.scope$/);
    await NodeAssert.strict.rejects(NodeFSP.stat(workDirectory), { code: "ENOENT" });
    if (!supervisor.pid) throw new Error("Supervisor PID was unavailable");
    process.kill(supervisor.pid, "SIGKILL");
    await new Promise<void>((resolve) => supervisor.once("close", () => resolve()));
    await NodeAssert.strict.rejects(NodeFSP.stat(workDirectory), { code: "ENOENT" });
    await waitForCgroupFile(
      `/sys/fs/cgroup${controlGroup}/cgroup.events`,
      (events) => /^populated 0$/m.test(events),
      6_000,
    );
    try {
      const events = await NodeFSP.readFile(`/sys/fs/cgroup${controlGroup}/cgroup.events`, "utf8");
      NodeAssert.strict.match(events, /^populated 0$/m);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    if (supervisor.pid && supervisor.exitCode === null) {
      try {
        process.kill(supervisor.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    }
    if (unitName) {
      try {
        await execFileAsync("/usr/bin/systemctl", ["--user", "stop", unitName], { timeout: 3_000 });
      } catch {
        /* exact unit may already be gone */
      }
    }
  }
});

it.skipIf(!available)("stops a scoped sandbox with a detached child", async () => {
  const childScript =
    "require('node:fs').writeFileSync('/tmp/detached-child-ready','ready');process.stdout.write('DETACHED_CHILD_READY\\n');setInterval(()=>{},1000)";
  const callerScript =
    "const {spawn}=require('node:child_process');const c=spawn('/usr/bin/node',['-e'," +
    JSON.stringify(childScript) +
    "],{detached:true,stdio:['ignore','inherit','ignore'],env:{}});c.unref();process.stdout.write('CALLER_READY\\n');setInterval(()=>{},1000)";
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", callerScript],
    runtimeMs: 3_000,
  });
  const directory = `/proc/${handle.sandboxPid}/root/workspace/tmp`;
  const watcher = NodeFSP.watch(directory, { signal: AbortSignal.timeout(2_000) });
  try {
    await handle.start();
    const ready = () =>
      NodeFSP.stat(`${directory}/detached-child-ready`).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    if (!(await ready())) {
      for await (const _ of watcher) {
        if (await ready()) break;
      }
    }
    NodeAssert.strict.equal(await ready(), true);
  } finally {
    await watcher.return?.();
  }
  const result = await handle.stop();
  NodeAssert.strict.equal(result.timedOut, false);
  NodeAssert.strict.match(result.stdout, /DETACHED_CHILD_READY/);
  NodeAssert.strict.equal(await handle.stop(), result);
});

it.skipIf(!available)("FD4 EOF cannot run caller code without the exact FD5 token", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('UNAUTHORIZED_EXECUTION\\n')"],
  });
  const result = await handle.discard();
  NodeAssert.strict.equal(result.exitCode, 125);
  NodeAssert.strict.doesNotMatch(result.stdout, /UNAUTHORIZED_EXECUTION/);
});

it.skipIf(!available)("does not pass FD5 into caller code", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "try { process.stdout.write('FD5='+require('node:fs').readlinkSync('/proc/self/fd/5')+'\\n') } catch { process.stdout.write('FD5_CLOSED\\n') }",
    ],
  });
  const gatePipe = await NodeFSP.readlink(`/proc/${handle.sandboxPid}/fd/5`);
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.equal(result.exitCode, 0);
  NodeAssert.strict.match(gatePipe, /^(pipe|socket):/);
  NodeAssert.strict.equal(result.stdout.includes(`FD5=${gatePipe}`), false);
});

it.skipIf(!available)("normal completion verifies scope cleanup", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: [
      "/usr/bin/node",
      "-e",
      "const {spawn}=require('node:child_process');const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{}});c.unref();process.stdout.write('PARENT_DONE\\n')",
    ],
  });
  await handle.start();
  const result = await handle.wait();
  NodeAssert.strict.match(result.stdout, /PARENT_DONE/);
  await NodeAssert.strict.rejects(NodeFSP.stat(handle.workDirectory), { code: "ENOENT" });
});

it.skipIf(!available)("rejects a raised memory limit before releasing caller code", async () => {
  const handle = await prepareOrganizationScopedSandbox({
    argv: ["/usr/bin/node", "-e", "process.stdout.write('UNVERIFIED_EXECUTION\\n')"],
  });
  try {
    await execFileAsync(
      "/usr/bin/systemctl",
      ["--user", "set-property", "--runtime", handle.unitName, "MemoryMax=536870912"],
      { timeout: 2_000 },
    );
    await NodeAssert.strict.rejects(handle.start(), /limits could not be verified/);
  } finally {
    const result = await handle.stop();
    NodeAssert.strict.doesNotMatch(result.stdout, /UNVERIFIED_EXECUTION/);
  }
});

it.skipIf(!available)(
  "systemd enforces a wall-clock ceiling while supervisor timers are stalled",
  async () => {
    const handle = await prepareOrganizationScopedSandbox({
      argv: ["/usr/bin/node", "-e", "setInterval(() => {}, 1000)"],
      runtimeMs: 100,
    });
    await handle.start();
    // Keep this event loop blocked past the 100ms soft timer and the independent
    // 3.1s scope deadline. Inspect systemd synchronously before timers can run.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600);
    const status = NodeChildProcess.execFileSync(
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        handle.unitName,
        "--property=ActiveState,Result,InvocationID,RuntimeMaxUSec",
      ],
      { encoding: "utf8", timeout: 1_000 },
    );
    NodeAssert.strict.match(status, /ActiveState=failed/);
    NodeAssert.strict.match(status, /Result=timeout/);
    NodeAssert.strict.ok(status.includes(`InvocationID=${handle.invocationId}`));
    NodeAssert.strict.match(status, /RuntimeMaxUSec=3\.1(?:0*)s/);
    const result = await handle.wait();
    NodeAssert.strict.equal(result.timedOut, true);
  },
);
