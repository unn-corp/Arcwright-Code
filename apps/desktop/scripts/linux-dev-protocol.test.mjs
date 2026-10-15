import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "vite-plus/test";
import { makeLinuxDevProtocolLauncher } from "./linux-dev-protocol.mjs";

describe("Linux development OAuth return", () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This native shell integration test requires a POSIX host.
  it.skipIf(NodeOS.platform() === "win32")(
    "returns to the originating entrypoint and profile despite an installed app's environment",
    () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-oauth-return-"));
      try {
        const executable = NodePath.join(directory, "fake electron");
        const output = NodePath.join(directory, "result.json");
        NodeFS.writeFileSync(
          executable,
          `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.PROBE_OUTPUT,JSON.stringify({args:process.argv.slice(2),url:process.env.VITE_DEV_SERVER_URL,home:process.env.T3CODE_HOME,config:process.env.XDG_CONFIG_HOME,runAsNode:process.env.ELECTRON_RUN_AS_NODE,appImage:process.env.APPIMAGE}));\n`,
          { mode: 0o755 },
        );
        const launcher = NodePath.join(directory, "return.sh");
        const mainEntryPath = "/worktree with spaces/apps/desktop/dist-electron/main.cjs";
        NodeFS.writeFileSync(
          launcher,
          makeLinuxDevProtocolLauncher({
            electronBinaryPath: executable,
            electronArgs: ["--no-sandbox"],
            mainEntryPath,
            environment: {
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5733/",
              T3CODE_HOME: "/private/dev's home",
              XDG_CONFIG_HOME: "/private/dev-profile",
              CLERK_SECRET_KEY: "must-not-be-captured",
            },
          }),
          { mode: 0o700 },
        );
        const callback = "t3code-dev://app/auth/callback?code=opaque&state=probe";
        const result = NodeChildProcess.spawnSync(launcher, [callback], {
          env: {
            ...process.env,
            PROBE_OUTPUT: output,
            VITE_DEV_SERVER_URL: "http://old-app/",
            T3CODE_HOME: "/live/home",
            XDG_CONFIG_HOME: "/old/profile",
            ELECTRON_RUN_AS_NODE: "1",
            APPIMAGE: "/old.AppImage",
          },
          encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(NodeFS.readFileSync(output, "utf8")), {
          args: ["--no-sandbox", mainEntryPath, callback],
          url: "http://127.0.0.1:5733/",
          home: "/private/dev's home",
          config: "/private/dev-profile",
        });
        assert.notInclude(NodeFS.readFileSync(launcher, "utf8"), "must-not-be-captured");
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
