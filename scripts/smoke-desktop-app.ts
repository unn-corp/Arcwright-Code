// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Launches a packaged desktop app against a seeded T3 home, opens a thread, and checks its
// messages render. Release jobs run it so a build whose backend or bundle cannot start fails
// before it is published.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import * as HostProcess from "@t3tools/shared/HostProcess";

// A snapshot from an older build on purpose: the packaged server must migrate it forward, as it
// does for every upgrading user. It holds one project and two threads, nothing else.
const FIXTURE_DB = NodePath.join(import.meta.dirname, "fixtures/desktop-launch/statev2.sqlite");
const THREAD_TITLE = "Release launch check";
const THREAD_MESSAGE = "The release opens and shows this thread.";
const STEP_TIMEOUT_MS = 60_000;

const waitForApplicationWindow = Effect.fn("smokeDesktop.waitForApplicationWindow")(function* (
  app: ElectronApplication,
) {
  while (true) {
    // The connecting splash uses data: and closes when the application window opens.
    const page = app
      .windows()
      .find((window) => /^(t3code(?:-dev)?|https?|file):/.test(window.url()));
    if (page && !page.isClosed()) return page;
    yield* Effect.sleep(100);
  }
}, Effect.timeout(STEP_TIMEOUT_MS));

function captureRendererErrors(page: Page) {
  page.on("pageerror", (error) => console.error("Renderer error:", error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Renderer console:", message.text());
  });
}

const { values } = NodeUtil.parseArgs({
  options: {
    executable: { type: "string" },
    "artifacts-dir": { type: "string" },
    "server-entry": { type: "string" },
  },
});
const executable = values.executable;
if (!executable)
  throw new Error("Usage: smoke-desktop-app.ts --executable <app> [--artifacts-dir <dir>]");
const artifactsDir = NodePath.resolve(values["artifacts-dir"] ?? "desktop-launch-check");

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-launch-"));
const t3Home = NodePath.join(home, "t3");
const maintenanceNamespace = NodePath.join(home, "maintenance");
NodeFS.mkdirSync(maintenanceNamespace, { mode: 0o700 });
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.copyFileSync(FIXTURE_DB, NodePath.join(t3Home, "userdata/statev2.sqlite"));
NodeFS.writeFileSync(
  NodePath.join(t3Home, "userdata/settings.json"),
  JSON.stringify(
    Object.fromEntries(
      [
        "repositoryReview",
        "continuousImprovement",
        "productOpportunityDiscovery",
        "decisionFollowUp",
        "pullRequestRollup",
        "inactiveWorktreeCleanup",
      ].map((policy) => [policy, { enabled: false }]),
    ),
  ),
);
const env = {
  ...process.env,
  // HOME stays real: macOS needs the login keychain. All app data remains isolated.
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  XDG_DATA_HOME: NodePath.join(home, ".local/share"),
  T3CODE_HOME: t3Home,
  T3CODE_MAINTENANCE_NAMESPACE: maintenanceNamespace,
  T3CODE_TELEMETRY_ENABLED: "false",
  T3CODE_DISABLE_AUTO_UPDATE: "true",
};

const deadline = (ms: number, message: string): Promise<never> =>
  NodeTimersPromises.setTimeout(ms, undefined, { ref: false }).then(() => {
    throw new Error(message);
  });

let step = "launching the app";
let app: ElectronApplication | undefined;
let broker: ReturnType<typeof NodeChildProcess.spawn> | undefined;
let brokerExited: Promise<void> | undefined;
try {
  if (HostProcess.Platform.defaultValue() === "linux") {
    step = "starting the fixture launch broker";
    const entry =
      values["server-entry"] ??
      NodePath.join(
        NodePath.dirname(NodePath.resolve(executable)),
        "resources/app.asar/apps/server/dist/bin.mjs",
      );
    // Start before Playwright opens inspector sockets; the persistent daemon must not inherit them.
    broker = NodeChildProcess.spawn(
      executable,
      [entry, "__organization-launch-broker", "--base-dir", t3Home],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const child = broker;
    brokerExited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString("utf8")).slice(-4_096);
    });
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-1_024);
          if (output.includes("READY\n")) resolve();
        });
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          reject(
            new Error(`Fixture broker exited before readiness (${code ?? signal}): ${errors}`),
          ),
        );
      }),
      deadline(10_000, "Fixture launch broker startup timed out"),
    ]);
  }
  step = "launching the app";
  app = await _electron.launch({
    executablePath: executable,
    // Linux CI runners do not allow the Chromium sandbox's user namespaces.
    args: ["--no-sandbox"],
    env,
    timeout: STEP_TIMEOUT_MS,
  });
  app.on("window", captureRendererErrors);
  app.windows().forEach(captureRendererErrors);
  // A backend that never starts leaves no window, or only the "could not start" window, so the
  // thread wait below fails either way and its screenshot shows the startup error.
  step = "waiting for the application window";
  const page = await Effect.runPromise(waitForApplicationWindow(app));
  step = `finding "${THREAD_TITLE}" in the sidebar`;
  const thread = page.locator("li[data-thread-item]", { hasText: THREAD_TITLE });
  await thread.waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS });
  const sidebarToggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
  await sidebarToggle.waitFor({ timeout: STEP_TIMEOUT_MS });
  if (!(await thread.isVisible())) await sidebarToggle.click();
  await thread.waitFor({ timeout: STEP_TIMEOUT_MS });
  step = "opening the thread";
  await thread.click();
  await page.getByText(THREAD_MESSAGE).waitFor({ timeout: STEP_TIMEOUT_MS });
  console.log("Desktop launch check passed: the app opened and showed the seeded thread.");
} catch (error) {
  console.error(`Desktop launch check failed while ${step}.`);
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  await app
    ?.windows()
    .findLast((page) => !page.isClosed())
    ?.screenshot({ path: NodePath.join(artifactsDir, "window.png"), timeout: 10_000 })
    .catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  const logs = NodePath.join(t3Home, "userdata/logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
    const serverLog = NodePath.join(logs, "server-child.log");
    if (NodeFS.existsSync(serverLog)) {
      console.error("\nLast backend output (server-child.log):");
      console.error(NodeFS.readFileSync(serverLog, "utf8").split("\n").slice(-20).join("\n"));
    }
  }
  process.exitCode = 1;
} finally {
  if (app) {
    const child = app.process();
    try {
      await Promise.race([app.close(), deadline(45_000, "Desktop app close timed out")]);
      if (child.exitCode !== 0) {
        console.error(`Desktop exited with ${child.exitCode ?? child.signalCode}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error("Desktop shutdown failed:", error);
      process.exitCode = 1;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  try {
    if (broker) {
      // This daemon intentionally survives desktop shutdown; dispose only our captured fixture child.
      if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGKILL");
      await Promise.race([brokerExited, deadline(10_000, "Fixture broker disposal timed out")]);
      broker.stdout?.destroy();
      broker.stderr?.destroy();
    }
    NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.error(`Fixture cleanup failed; retaining ${home}:`, error);
    process.exitCode = 1;
  }
}
