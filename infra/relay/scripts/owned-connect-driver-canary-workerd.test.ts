import * as NodeModule from "node:module";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Clock from "effect/Clock";
import { resolveSource, makeSourceContext } from "@alchemy.run/cloudflare/Workers";
import * as Artifacts from "alchemy/Artifacts";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { deadlineFixtureProps } from "./owned-connect-driver-canary-deadline-fixture.ts";
import { buildDriverCanaryOffline } from "./owned-connect-driver-canary-offline.ts";
import {
  CANARY_HEADER,
  CANARY_CONTRACT,
  canaryWorkerProps,
} from "../src/ownedConnectDriverCanary.ts";

class WorkerdFixtureFailed extends Schema.TaggedError<WorkerdFixtureFailed>()(
  "WorkerdFixtureFailed",
  {},
) {}

const require = NodeModule.createRequire(import.meta.url);
const workerd = require("workerd") as { readonly default: string };

const TOKEN = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SYNTHETIC_URL = "postgres://fixture:fixture@192.0.2.1:5432/fixture";

const waitForWorkerdListen = Effect.fnUntraced(function* (
  child: ChildProcessHandle,
  socket: string,
) {
  const event = yield* child.getOutputFd(3).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => JSON.parse(line) as { readonly event: string; readonly socket: string }),
    Stream.filter((message) => message.event === "listen" && message.socket === socket),
    Stream.runHead,
  );
  if (Option.isNone(event)) return yield* new WorkerdFixtureFailed();
});

const request = Effect.fnUntraced(
  function* (socketPath: string, method: "GET" | "POST", path: string, token?: string) {
    const dispatcher = yield* Effect.acquireRelease(
      Effect.sync(() => new Undici.Client("http://fixture.invalid", { socketPath })),
      (client) => Effect.promise(() => client.destroy()),
    );
    const client = yield* NodeHttpClient.makeUndici.pipe(
      Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
    );
    let outgoing = HttpClientRequest.make(method)(`http://fixture.invalid${path}`);
    if (token !== undefined) outgoing = HttpClientRequest.setHeader(outgoing, CANARY_HEADER, token);
    const response = yield* client.execute(outgoing);
    return { status: response.status, body: yield* response.text };
  },
  Effect.scoped,
  Effect.timeout("20 seconds"),
  Effect.catchCause(() => Effect.fail(new WorkerdFixtureFailed())),
);

it.live(
  "returns deadline failures while the actual workerd bridge owns stalled coordinator cleanup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner;
      const root = yield* fs.makeTempDirectory({
        directory: "/tmp",
        prefix: "arcwright-deadline-",
      });
      yield* fs.chmod(root, 0o700);
      yield* Effect.gen(function* () {
        const built = yield* Effect.gen(function* () {
          const source = yield* resolveSource(deadlineFixtureProps);
          return yield* source.build(
            makeSourceContext({
              dotAlchemy: root,
              id: "OwnedConnectDriverDeadlineFixture",
              fqn: "OwnedConnectDriverDeadlineFixture",
              workerName: deadlineFixtureProps.name,
              props: deadlineFixtureProps,
              compatibility: deadlineFixtureProps.compatibility,
              stack: {
                name: "ArcwrightConnectDriverDeadlineFixture",
                stage: "devotek-driver-canary",
              },
            }),
          );
        }).pipe(
          Effect.provideService(
            Artifacts.Artifacts,
            Artifacts.makeScopedArtifacts(
              Artifacts.createArtifactStore(),
              "OwnedConnectDriverDeadlineFixture",
            ),
          ),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: root,
            dev: false,
            adopt: false,
            updateStateStore: false,
          }),
          Effect.scoped,
        );
        if (!built.bundle || built.assets !== undefined) return yield* new WorkerdFixtureFailed();
        for (const file of built.bundle.files) {
          const filename = path.join(root, file.path);
          yield* fs.makeDirectory(path.dirname(filename), { recursive: true, mode: 0o700 });
          yield* fs.writeFile(
            filename,
            typeof file.content === "string"
              ? new TextEncoder().encode(file.content)
              : file.content,
            { mode: 0o600 },
          );
        }
        const modules = built.bundle.files
          .map(
            (file) =>
              `(name=${JSON.stringify(file.path)}, ${file.path.endsWith(".js") ? "esModule" : "text"}=embed ${JSON.stringify(file.path)})`,
          )
          .join(",\n");
        const config = path.join(root, "deadline.capnp");
        yield* fs.writeFileString(
          config,
          `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [
(name="fixture", worker=(modules=[${modules}], compatibilityDate="2026-09-18", compatibilityFlags=["new_module_registry"], globalOutbound="deny-all", bindings=[
(name="ALCHEMY_PHASE",text="runtime"),(name="ALCHEMY_WORKER_NAME",text="arcwright-offline-driver-deadline"),
(name="ALCHEMY_STACK_NAME",text="ArcwrightConnectDriverDeadlineFixture"),(name="ALCHEMY_STAGE",text="devotek-driver-canary"),
(name="ALCHEMY_CLOUDFLARE_ACCOUNT_ID",text="00000000000000000000000000000000")
])),(name="deny-all",network=(allow=[],deny=["0.0.0.0/0","::/0","unix","unix-abstract"]))],
sockets=[(name="http",address="127.0.0.1:0",http=(),service="fixture")]);`,
          { mode: 0o600 },
        );
        const socket = path.join(root, "http.sock");
        const binary = workerd.default;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(
                binary,
                [
                  "serve",
                  "--experimental",
                  "--control-fd=3",
                  config,
                  "config",
                  "--socket-addr",
                  `http=unix:${socket}`,
                ],
                {
                  additionalFds: { fd3: { type: "output" } },
                  env: {},
                  cwd: root,
                  detached: false,
                  killSignal: "SIGTERM",
                  forceKillAfter: "2 seconds",
                },
              ),
            );
            const logs: string[] = [];
            const cleanupDone = yield* Deferred.make<void>();
            const collectLog = (bytes: Uint8Array) =>
              Effect.sync(() => logs.push(new TextDecoder().decode(bytes))).pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    logs.join("").includes("ARCWRIGHT_DEADLINE_FIXTURE_CLEANUP_DONE")
                      ? Deferred.succeed(cleanupDone, undefined)
                      : Effect.void,
                  ),
                ),
              );
            const stderr = yield* child.stderr.pipe(
              Stream.runForEach(collectLog),
              Effect.forkScoped,
            );
            const stdout = yield* child.stdout.pipe(
              Stream.runForEach(collectLog),
              Effect.forkScoped,
            );
            let elapsedMs = 0;
            let completed = false;
            let cleanupPendingAtResponse = false;
            yield* Effect.gen(function* () {
              yield* waitForWorkerdListen(child, "http");
              expect(JSON.parse((yield* request(socket, "GET", "/status")).body)).toEqual({
                completed: [],
                finalized: [],
              });
              const phases = ["begin", "commit", "rollback", "scope-finalizer"];
              const start = yield* Clock.currentTimeMillis;
              const results = yield* Effect.forEach(
                phases,
                (phase) => request(socket, "POST", `/${phase}`),
                { concurrency: 4 },
              );
              elapsedMs = (yield* Clock.currentTimeMillis) - start;
              expect(results).toEqual(
                phases.map(() => ({ status: 503, body: '{"error":"probe_failed"}' })),
              );
              expect(elapsedMs).toBeGreaterThanOrEqual(14500);
              expect(elapsedMs).toBeLessThan(16500);
              expect(JSON.parse((yield* request(socket, "GET", "/status")).body)).toEqual({
                completed: [],
                finalized: [],
              });
              cleanupPendingAtResponse = true;
              yield* Deferred.await(cleanupDone);
              const completion = yield* request(socket, "GET", "/status");
              expect(completion.status).toBe(200);
              const status: unknown = JSON.parse(completion.body);
              if (
                typeof status !== "object" ||
                status === null ||
                !("completed" in status) ||
                !("finalized" in status) ||
                !Array.isArray(status.completed) ||
                !Array.isArray(status.finalized)
              )
                return yield* new WorkerdFixtureFailed();
              expect(status.completed.sort()).toEqual(phases.sort());
              expect(status.finalized.sort()).toEqual(phases);
              completed = true;
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  if (yield* child.isRunning) yield* child.kill();
                  yield* child.exitCode.pipe(Effect.timeout("5 seconds"), Effect.ignore);
                  yield* Fiber.join(stderr).pipe(Effect.timeout("2 seconds"), Effect.orDie);
                  yield* Fiber.join(stdout).pipe(Effect.timeout("2 seconds"), Effect.orDie);
                  expect(yield* child.isRunning).toBe(false);
                  expect(logs.join("")).not.toMatch(/unhandled|uncaught/i);
                  const evidence = process.env.ARCWRIGHT_DRIVER_CANARY_TEST_EVIDENCE;
                  if (evidence) {
                    yield* fs.writeFileString(
                      path.join(evidence, `deadline-workerd-${child.pid}.log`),
                      logs.join(""),
                      { mode: 0o600 },
                    );
                    yield* fs.writeFileString(
                      path.join(evidence, `deadline-workerd-${child.pid}.receipt.json`),
                      JSON.stringify({
                        completed,
                        capturedNativePid: child.pid,
                        exited: true,
                        elapsedMs,
                        bundleHash: built.bundle?.hash,
                        phases: ["begin", "commit", "rollback", "scope-finalizer"],
                        deadlineStatuses: [503, 503, 503, 503],
                        cleanupPendingAtResponse,
                        allFourFinalizedLater: completed,
                      }),
                      { mode: 0o600 },
                    );
                  }
                }).pipe(Effect.orDie),
              ),
            );
          }),
        );
      }).pipe(Effect.ensuring(fs.remove(root, { recursive: true }).pipe(Effect.orDie)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "runs every unmodified emitted module in installed workerd with denied numeric outbound",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner;
      const root = yield* fs.makeTempDirectory({ directory: "/tmp", prefix: "arcwright-driver-" });
      yield* fs.chmod(root, 0o700);
      yield* Effect.gen(function* () {
        const built = yield* buildDriverCanaryOffline(root);
        for (const file of built.bundle.files) {
          const content =
            typeof file.content === "string"
              ? file.content
              : new TextDecoder().decode(file.content);
          expect(content).not.toContain(TOKEN);
          expect(content).not.toContain(SYNTHETIC_URL);
          if (file.path.endsWith(".map")) {
            const map: unknown = JSON.parse(content);
            if (
              typeof map !== "object" ||
              map === null ||
              !("sources" in map) ||
              !Array.isArray(map.sources)
            )
              return yield* new WorkerdFixtureFailed();
            expect(
              map.sources.some(
                (source: unknown) =>
                  typeof source === "string" &&
                  /infra\/relay\/(src\/(worker|db)\.ts|alchemy\.run\.ts|src\/persistence\/schema\.ts)$/.test(
                    source,
                  ),
              ),
            ).toBe(false);
          } else {
            expect(
              /(?:from|import)\s*(?:\(\s*)?["'][^"']*infra\/relay\/(?:src\/(?:worker|db)\.ts|alchemy\.run\.ts)/.test(
                content,
              ),
            ).toBe(false);
          }
          expect(Array.from(yield* fs.readFile(path.join(built.directory, file.path)))).toEqual(
            Array.from(
              typeof file.content === "string"
                ? new TextEncoder().encode(file.content)
                : file.content,
            ),
          );
        }
        expect(
          built.bundle.files.some(
            (file) => file.path.startsWith("PgClient-") && file.path.endsWith(".js"),
          ),
        ).toBe(true);
        const socketPath = path.join(root, "http.sock");
        const binary = workerd.default;
        expect(
          (yield* spawner.string(
            ChildProcess.make(binary, ["--version"], {
              env: {},
              cwd: root,
              detached: false,
            }),
          )).trim(),
        ).toBe("workerd 2026-09-18");
        const modules = built.bundle.files
          .map(
            (file) =>
              `(name = ${JSON.stringify(file.path)}, ${file.path.endsWith(".js") ? "esModule" : "text"} = embed ${JSON.stringify(`emitted/${file.path}`)})`,
          )
          .join(",\n");
        const configFile = path.join(root, "canary.capnp");
        const fixture = (
          connectionString: string,
        ) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "canary", worker = (
    modules = [${modules}],
    compatibilityDate = "${canaryWorkerProps.compatibility.date}",
    compatibilityFlags = ["new_module_registry"], globalOutbound = "deny-all",
    bindings = [
      (name = "ARCWRIGHT_CONNECT_HYPERDRIVE", json = ${JSON.stringify(JSON.stringify({ connectionString }))}),
      (name = "ARCWRIGHT_CONNECT_DRIVER_CANARY_SECRET", text = ${JSON.stringify(JSON.stringify({ _tag: "Redacted", value: TOKEN }))}),
      (name = "ALCHEMY_PHASE", text = "runtime"),
      (name = "ALCHEMY_WORKER_NAME", text = "arcwright-connect-driver-canary"),
      (name = "ALCHEMY_STACK_NAME", text = "ArcwrightConnectDriverCanary"),
      (name = "ALCHEMY_STAGE", text = "devotek-driver-canary"),
      (name = "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", text = "00000000000000000000000000000000")
    ])),
    (name = "deny-all", network = (allow = [], deny = ["0.0.0.0/0", "::/0", "unix", "unix-abstract"]))],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "canary")]
);`;
        for (const connectionString of [SYNTHETIC_URL, "invalid-synthetic-binding"]) {
          yield* fs.writeFileString(configFile, fixture(connectionString), { mode: 0o600 });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* spawner.spawn(
                ChildProcess.make(
                  binary,
                  [
                    "serve",
                    "--experimental",
                    "--control-fd=3",
                    configFile,
                    "config",
                    "--socket-addr",
                    `http=unix:${socketPath}`,
                  ],
                  {
                    additionalFds: { fd3: { type: "output" } },
                    env: {},
                    cwd: root,
                    detached: false,
                    killSignal: "SIGTERM",
                    forceKillAfter: "2 seconds",
                  },
                ),
              );
              expect(child.pid).toBeGreaterThan(0);
              const logs: string[] = [];
              let completed = false;
              const stderr = yield* child.stderr.pipe(
                Stream.runForEach((bytes) =>
                  Effect.sync(() => {
                    logs.push(new TextDecoder().decode(bytes));
                  }),
                ),
                Effect.forkScoped,
              );
              yield* child.stdout.pipe(Stream.runDrain, Effect.forkScoped);
              yield* Effect.gen(function* () {
                yield* waitForWorkerdListen(child, "http");
                const missing = yield* request(socketPath, "POST", "/probe");
                expect(missing).toEqual({ status: 401, body: '{"error":"unauthorized"}' });
                expect((yield* request(socketPath, "POST", "/probe", "wrong")).status).toBe(401);
                const metadata = yield* request(socketPath, "GET", "/metadata", TOKEN);
                expect(metadata.status).toBe(200);
                expect(JSON.parse(metadata.body)).toEqual({
                  contract: CANARY_CONTRACT,
                  build: {
                    compatibilityDate: "2026-09-18",
                    driver: "@alchemy.run/drizzle/Postgres",
                  },
                  prepare: false,
                });
                expect((yield* request(socketPath, "GET", "/other", TOKEN)).status).toBe(404);
                expect((yield* request(socketPath, "GET", "/probe", TOKEN)).status).toBe(405);
                expect(yield* request(socketPath, "POST", "/probe", TOKEN)).toEqual({
                  status: 503,
                  body: '{"error":"probe_failed"}',
                });
                completed = true;
                expect(logs.join("")).not.toContain(TOKEN);
                expect(logs.join("")).not.toContain(SYNTHETIC_URL);
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    if (yield* child.isRunning) yield* child.kill();
                    yield* child.exitCode.pipe(Effect.timeout("5 seconds"), Effect.ignore);
                    yield* Fiber.join(stderr).pipe(Effect.timeout("2 seconds"), Effect.orDie);
                    expect(yield* child.isRunning).toBe(false);
                    expect(logs.join("")).not.toContain(TOKEN);
                    expect(logs.join("")).not.toContain(SYNTHETIC_URL);
                    if (completed && connectionString === SYNTHETIC_URL)
                      expect(logs.join("")).toContain("connect() blocked by restrictPeers()");
                    yield* fs.writeFileString(
                      path.join(root, "synthetic-workerd.log"),
                      logs.join(""),
                      { mode: 0o600 },
                    );
                    const evidence = process.env.ARCWRIGHT_DRIVER_CANARY_TEST_EVIDENCE;
                    if (evidence) {
                      const stat = yield* fs.stat(evidence);
                      if (
                        !path.isAbsolute(evidence) ||
                        (yield* fs.realPath(evidence)) !== evidence ||
                        stat.type !== "Directory" ||
                        (stat.mode & 0o777) !== 0o700
                      )
                        return yield* new WorkerdFixtureFailed();
                      yield* fs.writeFileString(
                        path.join(evidence, `workerd-${child.pid}.log`),
                        logs.join(""),
                        { mode: 0o600 },
                      );
                      yield* fs.writeFileString(
                        path.join(evidence, `workerd-${child.pid}.receipt.json`),
                        JSON.stringify({
                          completed,
                          capturedNativePid: child.pid,
                          exited: true,
                          bundleHash: built.bundle.hash,
                          emittedFiles: built.bundle.files.length,
                          connectionFixture:
                            connectionString === SYNTHETIC_URL ? "denied-numeric" : "malformed",
                          statuses: completed ? [401, 401, 200, 404, 405, 503] : [],
                          compatibility: {
                            date: canaryWorkerProps.compatibility.date,
                            flags: ["new_module_registry"],
                          },
                          networkPolicy: {
                            allow: [],
                            deny: ["0.0.0.0/0", "::/0", "unix", "unix-abstract"],
                          },
                        }),
                        { mode: 0o600 },
                      );
                    }
                    if (yield* fs.exists(socketPath)) yield* fs.remove(socketPath);
                  }).pipe(Effect.orDie),
                ),
              );
            }),
          );
        }
      }).pipe(Effect.ensuring(fs.remove(root, { recursive: true }).pipe(Effect.orDie)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
