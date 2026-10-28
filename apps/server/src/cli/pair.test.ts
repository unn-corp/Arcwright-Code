// @effect-diagnostics nodeBuiltinImport:off globalDate:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, CliError } from "effect/cli";
import { vi } from "vite-plus/test";

import * as SqliteDiagnostics from "../../../../packages/shared/src/nodeSqliteDiagnostics.ts";
import { cli } from "../binCli.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { DevServerNotProxiableError, resolveTailscaleLocalTarget } from "./pair.ts";

import packageJson from "../../package.json" with { type: "json" };
import { buildPairingAppLink } from "@t3tools/shared/remote";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair tailscale local target", () => {
  it("proxies the dev web port for dev servers", () => {
    expect(
      resolveTailscaleLocalTarget({
        ...baseState,
        devUrl: "http://localhost:5733/",
      }),
    ).toEqual({ localPort: 5_733 });
    // tailscale serve defaults to loopback, so non-loopback dev servers need an explicit target.
    expect(
      resolveTailscaleLocalTarget({
        ...baseState,
        devUrl: "http://192.168.1.10:5733/",
      }),
    ).toEqual({ localPort: 5_733, localHost: "192.168.1.10" });
    expect(
      resolveTailscaleLocalTarget({
        ...baseState,
        devUrl: "http://[fd7a:115c::1]:5733/",
      }),
    ).toEqual({ localPort: 5_733, localHost: "[fd7a:115c::1]" });
  });

  it("rejects HTTPS dev URLs, which tailscale serve cannot proxy", () => {
    expect(
      resolveTailscaleLocalTarget({
        ...baseState,
        devUrl: "https://localhost:5733/",
      }),
    ).toBeInstanceOf(DevServerNotProxiableError);
  });
});

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(layerCliRuntime, TestConsole.layer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const captureAllStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return yield* TestConsole.logLines;
    }),
  );

const testDescriptor = {
  environmentId: "pair-test-environment",
  label: "pair-test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};

const withDescriptorServer = <A, E, R>(
  run: (
    origin: string,
    requests: Array<{ scopes: ReadonlyArray<string>; label?: string }>,
  ) => Effect.Effect<A, E, R>,
  host = "127.0.0.1",
  descriptor: object = testDescriptor,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.acquireUseRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const requests: Array<{ scopes: ReadonlyArray<string>; label?: string }> = [];
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/.well-known/t3/environment") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(descriptor));
            return;
          }
          if (
            request.url === "/api/maintenance/operator/pairing" &&
            request.headers["x-t3-operator-token"] === "test-operator"
          ) {
            let body = "";
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              const input = JSON.parse(body);
              requests.push(input);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  id: "test-pairing",
                  credential: "TESTPAIRCODE",
                  scopes: input.scopes,
                  subject: "one-time-token",
                  label: input.label,
                  createdAt: new Date(now).toISOString(),
                  expiresAt: new Date(now + 300_000).toISOString(),
                }),
              );
            });
            return;
          }
          response.writeHead(404);
          response.end();
        });
        Object.assign(server, { pairingRequests: requests });
        server.once("error", (cause) => resume(Effect.die(cause)));
        server.listen(0, host, () => resume(Effect.succeed(server)));
        return Effect.sync(() => {
          server.close();
        });
      }),
      (server) => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          return Effect.die(new Error("Expected a TCP address"));
        }
        return run(
          `http://${host === "::1" ? "[::1]" : host}:${String(address.port)}`,
          (
            server as NodeHttp.Server & {
              pairingRequests: Array<{
                scopes: ReadonlyArray<string>;
                label?: string;
              }>;
            }
          ).pairingRequests,
        );
      },
      (server) => Effect.sync(() => server.close()),
    );
  });

describe("t3 pair", () => {
  it.effect("publishes an IPv6-only server URL through Tailscale Serve when pairing", () =>
    withDescriptorServer(
      (origin, requests) =>
        Effect.gen(function* () {
          const fetch = yield* FetchHttpClient.Fetch;
          // Exercise the IPv6 URL contract even on CI runners without IPv6 loopback.
          // Only transport is redirected to the real HTTP fixture below.
          const ipv6Origin = `http://[::1]:${new URL(origin).port}`;
          let serving = false;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command))
                return yield* Effect.die("Unexpected pipeline");
              if (command.args[0] === "serve") {
                const target = command.args.at(-1)!;
                expect(target).toBe(ipv6Origin);
                const descriptor = yield* Effect.promise(async () =>
                  (await fetch(new URL("/.well-known/t3/environment", origin))).json(),
                );
                expect(descriptor).toEqual(testDescriptor);
                serving = true;
              }
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(
                  new TextEncoder().encode('{"Self":{"DNSName":"pair-test.tail.ts.net."}}'),
                ),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
            }),
          );

          const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-ipv6-test-"));
          NodeFS.mkdirSync(NodePath.join(baseDir, "maintenance"));
          NodeFS.writeFileSync(
            NodePath.join(baseDir, "maintenance", "operator-token"),
            "test-operator",
          );
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "::1", devUrl: undefined },
              port: Number(new URL(origin).port),
            }),
          });
          const output = yield* captureStdout(
            runCli([
              "pair",
              "--base-dir",
              baseDir,
              "--tailscale",
              "--scope",
              "orchestration:read",
            ]).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(HostProcess.Platform, "linux"),
              Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
                const url = new URL(String(input));
                if (url.origin === ipv6Origin) {
                  assert.oneOf(url.href, [
                    `${ipv6Origin}/.well-known/t3/environment`,
                    `${ipv6Origin}/api/maintenance/operator/pairing`,
                  ]);
                  assert.equal(
                    init?.method,
                    url.pathname === "/.well-known/t3/environment" ? "GET" : "POST",
                  );
                  return fetch(new URL(url.pathname, origin), init);
                }
                assert.equal(
                  String(input),
                  "https://pair-test.tail.ts.net/.well-known/t3/environment",
                );
                return serving
                  ? Response.json(testDescriptor)
                  : new Response(null, { status: 503 });
              }),
            ),
          );

          expect(serving).toBe(true);
          assert.include(output, "Pairing URL: https://pair-test.tail.ts.net/pair#token=");
          expect(requests).toEqual([{ scopes: ["orchestration:read"], label: "t3 pair" }]);
        }),
      "127.0.0.1",
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("mints a token and prints a QR pairing URL for a live server", () =>
    withDescriptorServer((origin, requests) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-test-"));
        NodeFS.mkdirSync(NodePath.join(baseDir, "maintenance"));
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "maintenance", "operator-token"),
          "test-operator",
        );
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, `Pairing with pair-test (${origin})`);
        assert.include(output, `Pairing URL: ${origin}/pair#token=`);
        assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
        assert.include(output, "only reachable from this machine");

        const token = /#token=([A-Z2-9]+)/.exec(output)?.[1];
        assert.isString(token);
        assert.include(output, `App link: ${buildPairingAppLink(`${origin}/pair#token=${token}`)}`);

        // Live issuance goes through the running server, without opening another database runtime.
        const credentials = requests;
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0]?.label, "t3 pair");
        assert.deepEqual(credentials[0]?.scopes, AuthStandardClientScopes);
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          childVersion: packageJson.version,
        }),
      }),
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
        connected: false,
        send: () => false,
        on: () => undefined,
        off: () => undefined,
      }),
    ),
  );

  it.effect("mints a pairing grant with only the selected scopes", () =>
    withDescriptorServer((origin, requests) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-scopes-test-"));
        NodeFS.mkdirSync(NodePath.join(baseDir, "maintenance"));
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "maintenance", "operator-token"),
          "test-operator",
        );
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        yield* captureStdout(
          runCli([
            "pair",
            "--base-dir",
            baseDir,
            "--scope",
            "orchestration:read",
            "--scope",
            "relay:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const credentials = requests;
        assert.lengthOf(credentials, 1);
        assert.deepEqual(credentials[0]?.scopes, ["orchestration:read", "relay:read"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pairs through the recorded dev web URL for dev servers", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-dev-test-"));
        NodeFS.mkdirSync(NodePath.join(baseDir, "maintenance"));
        NodeFS.writeFileSync(
          NodePath.join(baseDir, "maintenance", "operator-token"),
          "test-operator",
        );
        const port = Number(new URL(origin).port);
        const statePath = NodePath.join(baseDir, "dev", "server-runtime.json");
        yield* persistServerRuntimeState({
          path: statePath,
          state: yield* makePersistedServerRuntimeState({
            config: {
              host: undefined,
              devUrl: new URL("http://localhost:5733"),
            },
            port,
          }),
        });

        const output = yield* captureStdout(runCli(["pair", "--base-dir", baseDir]));

        assert.include(output, "Pairing URL: http://localhost:5733/pair#token=");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores runtime state whose recorded pid is no longer alive", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-pid-test-"));
        const statePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: Number(new URL(origin).port),
        });
        yield* persistServerRuntimeState({
          path: statePath,
          state: { ...state, pid: 4_194_305 },
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir]).pipe(Effect.flip),
        );

        const rendered = String(
          typeof error === "object" && error !== null && "cause" in error ? error.cause : error,
        );
        assert.include(rendered, "No running Arcwright Code server found.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #10516 minting opens the target database with this checkout's
  // migrations, so a worktree must never fall back to the live install.
  it.effect("does not fall back to the shared home from a linked worktree", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-worktree-test-"));
        const worktree = NodePath.join(root, "worktree");
        NodeFS.mkdirSync(worktree);
        NodeFS.writeFileSync(
          NodePath.join(worktree, ".git"),
          `gitdir: ${NodePath.join(root, "repo", ".git", "worktrees", "worktree")}\n`,
        );
        const sharedHome = NodePath.join(root, "shared");
        yield* persistServerRuntimeState({
          path: NodePath.join(sharedHome, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair"]).pipe(
            Effect.provideService(HostProcess.WorkingDirectory, worktree),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: sharedHome } })),
            ),
            Effect.flip,
          ),
        );

        assert.include(String(error), "No running Arcwright Code server found.");
        assert.notInclude(String(error), sharedHome);
        assert.deepEqual(NodeFS.readdirSync(NodePath.join(sharedHome, "userdata")), [
          "server-runtime.json",
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // regression: #15492 an older CLI minted into a V1 database the protocol 2
  // server never reads, so pairing must refuse before opening the database.
  it.effect("rejects a server on another protocol before opening its database", () =>
    withDescriptorServer(
      (origin) =>
        Effect.gen(function* () {
          const baseDir = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "t3-pair-protocol-test-"),
          );
          yield* persistServerRuntimeState({
            path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
            state: yield* makePersistedServerRuntimeState({
              config: { host: "127.0.0.1", devUrl: undefined },
              port: Number(new URL(origin).port),
            }),
          });

          const exit = yield* provideCliTestLayers(
            runCli(["pair", "--base-dir", baseDir]).pipe(Effect.exit),
          );

          assert.deepEqual(NodeFS.readdirSync(NodePath.join(baseDir, "userdata")), [
            "server-runtime.json",
          ]);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.include(String(Cause.squash(exit.cause)), "t3@0.0.45 pair");
          }
        }),
      "127.0.0.1",
      { ...testDescriptor, serverVersion: "0.0.45", orchestrationProtocolVersion: 1 },
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // Without the capability `tailscale serve` blocks on an enablement URL, so
  // pairing must stop at status instead of spawning it.
  it.effect("explains a tailnet without HTTPS serve instead of running tailscale serve", () =>
    withDescriptorServer((origin) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pair-ts-test-"));
        yield* persistServerRuntimeState({
          path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
          state: yield* makePersistedServerRuntimeState({
            config: { host: "127.0.0.1", devUrl: undefined },
            port: Number(new URL(origin).port),
          }),
        });
        const tailscaleCalls: Array<ReadonlyArray<string>> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          const { args } = command as unknown as {
            readonly args: ReadonlyArray<string>;
          };
          tailscaleCalls.push(args);
          const stdout =
            args[0] === "status"
              ? `{"Self":{"DNSName":"pair-test.invalid.","CapMap":{"funnel":null}}}`
              : "";
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(args[0] === "status" ? 0 : 1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });

        const error = yield* provideCliTestLayers(
          runCli(["pair", "--base-dir", baseDir, "--tailscale"]).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.flip,
          ),
        );

        assert.include(String(error), "Tailscale Serve is not enabled on your tailnet.");
        assert.include(String(error), "https://login.tailscale.com/admin/dns");
        assert.deepEqual(tailscaleCalls, [["status", "--json"]]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("auth scope options", () => {
  it.effect.each([
    { group: "pairing", action: "create" },
    { group: "session", action: "issue" },
  ] as const)(
    "issues and persists only the selected scopes for auth $group $action",
    ({ group, action }) =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-scopes-test-"),
        );
        const output = yield* captureStdout(
          runCli([
            "auth",
            group,
            action,
            "--base-dir",
            baseDir,
            "--json",
            "--scope",
            "orchestration:read",
            "--scope",
            "access:read",
            "--scope",
            "orchestration:read",
          ]),
        );
        const issued = JSON.parse(output) as {
          readonly scopes: ReadonlyArray<string>;
        };
        const listOutput = yield* captureStdout(
          runCli(["auth", group, "list", "--base-dir", baseDir, "--json"]),
        );
        const listed = JSON.parse(listOutput) as ReadonlyArray<{
          readonly scopes: ReadonlyArray<string>;
        }>;

        assert.deepEqual(issued.scopes, ["orchestration:read", "access:read"]);
        assert.lengthOf(listed, 1);
        assert.deepEqual(listed[0]?.scopes, issued.scopes);
      }),
  );

  it.effect.each([
    { mode: "JSON", command: ["pairing", "create", "--json"] },
    { mode: "token-only", command: ["session", "issue", "--token-only"] },
    { mode: "normal", command: ["pairing", "create"] },
  ] as const)(
    "honors the slow-SQLite diagnostic policy for auth $mode output",
    ({ mode, command }) =>
      Effect.gen(function* () {
        const baseDir = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-auth-output-test-")),
          ),
          (directory) =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const makeDiagnostics = SqliteDiagnostics.make;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(SqliteDiagnostics, "make").mockImplementation(() => {
              let time = 0;
              // Each operation passes the warning budget without advancing real time.
              return makeDiagnostics(() => (time += 60_001));
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const stdout = yield* captureAllStdout(
          runCli(["auth", ...command, "--base-dir", baseDir, "--scope", "orchestration:read"]),
        );

        if (mode === "normal") {
          assert.include(stdout, "SQLite operation blocked the server");
          assert.isTrue(
            stdout.some(
              (value) =>
                typeof value === "object" &&
                value !== null &&
                "operation" in value &&
                value.operation === "close",
            ),
          );
          assert.isTrue(
            stdout.some(
              (value) =>
                typeof value === "string" && value.startsWith("Issued client pairing token "),
            ),
          );
          return;
        }

        assert.lengthOf(stdout, 1);
        assert.isString(stdout[0]);
        const output = String(stdout[0]);
        if (mode === "JSON") {
          const issued = JSON.parse(output) as { readonly scopes: ReadonlyArray<string> };
          assert.deepEqual(issued.scopes, ["orchestration:read"]);
        } else {
          assert.match(output, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/);
        }
      }).pipe(Effect.scoped, Effect.provideService(References.MinimumLogLevel, "Info")),
  );

  it.effect.each(
    [["pair"], ["auth", "pairing", "create"], ["auth", "session", "issue"]].map((command) => ({
      command,
      label: command.join(" "),
    })),
  )("rejects invalid scopes before running $label", ({ command }) =>
    Effect.gen(function* () {
      const error = yield* runCli([
        ...command,
        "--scope",
        "orchestration:read",
        "--scope",
        "admin",
      ]).pipe(Effect.provide(layerCliRuntime), Effect.flip);

      if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${String(error)}`);
      }
      assert.deepEqual(error.commandPath, ["t3", ...command]);
      const scopeError = error.errors[0];
      if (scopeError?._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(scopeError?._tag)}`);
      }
      assert.equal(scopeError.option, "scope");
      assert.equal(scopeError.value, "admin");
    }),
  );
});
