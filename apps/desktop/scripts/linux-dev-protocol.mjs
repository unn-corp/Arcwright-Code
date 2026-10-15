import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const desktopEntryName = "com.t3tools.T3Code.Development.desktop";
const callbackEnvironmentKeys = [
  "VITE_DEV_SERVER_URL",
  "T3CODE_PORT",
  "T3CODE_HOME",
  "T3CODE_CONNECT_MODE",
  "T3CODE_CONNECT_PROFILE_FILE",
  "T3CODE_MAINTENANCE_NAMESPACE",
  "T3CODE_URL_HANDLER_EXEC_TARGET",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function makeLinuxDevProtocolLauncher({
  electronBinaryPath,
  electronArgs = [],
  mainEntryPath,
  environment,
}) {
  return [
    "#!/bin/sh",
    "unset ELECTRON_RUN_AS_NODE APPIMAGE APPDIR T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT",
    // A browser can inherit an installed app's environment. Callback activation
    // must use this runner's profile and home to reach its single-instance lock.
    ...callbackEnvironmentKeys.map((key) =>
      environment[key]?.trim() ? `export ${key}=${shellQuote(environment[key])}` : `unset ${key}`,
    ),
    `exec ${[electronBinaryPath, ...electronArgs, mainEntryPath].map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

export function registerLinuxDevProtocol({
  electronBinaryPath,
  electronArgs = [],
  desktopRoot,
  environment = process.env,
  registrationEnvironment = environment,
}) {
  if (!environment.VITE_DEV_SERVER_URL?.trim()) {
    throw new Error("VITE_DEV_SERVER_URL is required for a development callback handler.");
  }
  const runtimeDirectory = NodePath.join(desktopRoot, ".electron-runtime");
  const execTarget = NodePath.join(runtimeDirectory, "dev-protocol-launcher.sh");
  NodeFS.mkdirSync(runtimeDirectory, { recursive: true });
  NodeFS.writeFileSync(
    execTarget,
    makeLinuxDevProtocolLauncher({
      electronBinaryPath,
      electronArgs,
      mainEntryPath: NodePath.join(desktopRoot, "dist-electron", "main.cjs"),
      environment: { ...environment, T3CODE_URL_HANDLER_EXEC_TARGET: execTarget },
    }),
    { mode: 0o700 },
  );
  NodeFS.chmodSync(execTarget, 0o700);
  const applicationsDirectory = NodePath.join(
    registrationEnvironment.XDG_DATA_HOME || NodePath.join(NodeOS.homedir(), ".local", "share"),
    "applications",
  );
  NodeFS.mkdirSync(applicationsDirectory, { recursive: true });
  // Desktop Exec arguments have both general string escaping and Exec quoting.
  const quotedTarget =
    `"${execTarget.replaceAll(/([\\`"$])/g, "\\$1").replaceAll("%", "%%")}"`.replaceAll(
      "\\",
      "\\\\",
    );
  const desktopEntryPath = NodePath.join(applicationsDirectory, desktopEntryName);
  NodeFS.writeFileSync(
    desktopEntryPath,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Arcwright Code (Dev)",
      `Exec=${quotedTarget} %U`,
      "Terminal=false",
      "NoDisplay=true",
      "StartupNotify=false",
      "MimeType=x-scheme-handler/t3code-dev;",
      "",
    ].join("\n"),
  );
  NodeChildProcess.spawnSync("update-desktop-database", [applicationsDirectory], {
    env: registrationEnvironment,
    stdio: "ignore",
    timeout: 5_000,
  });
  const result = NodeChildProcess.spawnSync(
    "xdg-mime",
    ["default", desktopEntryName, "x-scheme-handler/t3code-dev"],
    { env: registrationEnvironment, encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not register the desktop development callback handler: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  return { execTarget, desktopEntryPath };
}
