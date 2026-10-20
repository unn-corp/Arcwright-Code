import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, AuthSessionId, AuthRelayWriteScope } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { readPendingRemoteCleanup } from "../cloud/pendingRemoteCleanup.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Terminal from "effect/Terminal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NetService from "@t3tools/shared/Net";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import * as BootService from "../cloud/bootService.ts";
import {
  disconnectCloud,
  connectCommand,
  acquireRelayClientForLink,
  headlessSessionConfig,
  reportCloudDisconnectResults,
  reportServiceOnboarding,
} from "./connect.ts";
import { offerServiceDuringOnboarding, recoverServiceOnboardingOffer } from "./service.ts";

afterEach(() => vi.restoreAllMocks());

it.effect.each(["full", "corrupt"] as const)(
  "CLI logout reaches the live local unlink before a %s reminder failure and preserves authorization",
  (shape) => {
    const values = new Map<string, Uint8Array>([
      ["cloud-relay-url", new TextEncoder().encode("https://old.example.test")],
      ["cloud-public-authority", new TextEncoder().encode("foreign-binding")],
      ["cloud-hold-webhooks-while-offline", new TextEncoder().encode("true")],
      ["cloud-cli-desired-link", new TextEncoder().encode("managed")],
      ["cloud-cli-oauth-token", new TextEncoder().encode("old-authorization")],
    ]);
    const requests: string[] = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = path.dirname(config.serverRuntimeStatePath);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        config.serverRuntimeStatePath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      yield* fs.writeFileString(
        path.join(directory, "connect-pending-remote-cleanup.json"),
        shape === "corrupt"
          ? "not-json"
          : JSON.stringify(
              Array.from({ length: 16 }, (_, i) => ({
                relayOrigin: `https://old-${i}.example.test`,
                environmentId: `old-env-${i}`,
                unlinkedAt: "2026-01-01T00:00:00.000Z",
                status: "pending",
              })),
            ),
      );
      assert.equal(
        (yield* Effect.flip(disconnectCloud({ clearAuthorization: true })))._tag,
        "PendingRemoteCleanupError",
      );
      assert.deepEqual(requests, ["http://127.0.0.1:3773/api/connect/unlink"]);
      assert.isFalse(values.has("cloud-cli-desired-link"));
      assert.isTrue(values.has("cloud-public-authority"));
      assert.isTrue(values.has("cloud-hold-webhooks-while-offline"));
      assert.isTrue(values.has("cloud-cli-oauth-token"));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/", { prefix: "t3-cleanup-failure-cli-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
          set: (name, value) =>
            Effect.sync(() => {
              values.set(name, value);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
        }),
      ),
      Effect.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          issueSession: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("local-unlink"),
              token: "direct-fixture-token",
              method: "bearer-access-token",
              scopes: [AuthRelayWriteScope],
              subject: "cloud-cli",
              client: { deviceType: "unknown" },
              expiresAt: DateTime.makeUnsafe(0),
            }),
          revokeSession: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironmentIdentity,
        ServerEnvironment.ServerEnvironmentIdentity.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-one")),
        }),
      ),
      Effect.provide(Layer.mock(CliTokenManager.CloudCliTokenManager)({})),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url);
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  _tag: "EnvironmentCloudInternalError",
                  operation: "preserve-cleanup-reminder",
                  message: "Locally disabled; cleanup reminder unresolved.",
                },
                { status: 500 },
              ),
            );
          }),
        ),
      ),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_CONNECT_MODE: "cloudless" } })),
      ),
    );
  },
);

it.effect.each([
  { args: [] as string[] },
  { args: ["link"] },
  { args: ["link", "--publish-only"] },
])(
  "cloudless connect $args rejects before runtime, login, prompt or network side effects",
  ({ args }) => {
    const effects: string[] = [];
    const forbidden = (name: string) =>
      Effect.sync(() => {
        effects.push(name);
      }).pipe(Effect.andThen(Effect.die("unexpected managed action")));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-cloudless-command-",
      });
      vi.spyOn(RelayClient, "layerCloudflared").mockReturnValue(
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: forbidden("resolve"),
            install: forbidden("install"),
            installWithProgress: () => forbidden("download"),
            pruneManagedVersions: forbidden("prune"),
          }),
        ),
      );
      vi.spyOn(CliTokenManager, "layer", "get").mockReturnValue(
        Layer.succeed(
          CliTokenManager.CloudCliTokenManager,
          CliTokenManager.CloudCliTokenManager.of({
            get: forbidden("login"),
            getExisting: forbidden("getExisting"),
            hasCredential: forbidden("credential"),
            store: () => forbidden("store"),
            clear: forbidden("clear"),
          }),
        ),
      );
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected managed HTTP"));
      const error = yield* Effect.flip(
        Command.runWith(connectCommand, { version: "0.0.0" })([...args, "--base-dir", baseDir]),
      );
      assert.equal(error._tag, "CloudCliAuthorizationError");
      assert.include(error.message, "cloudless");
      assert.deepEqual(effects, []);
      assert.equal(fetch.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NetService.layer,
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            spawn: () => forbidden("spawn"),
          }),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3CODE_CONNECT_MODE: "cloudless" },
            }),
          ),
        ),
      ),
    );
  },
);

const readHeadlessSessionConfig = (env: Record<string, string>) =>
  headlessSessionConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("detects headless operation from individual SSH config values", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* readHeadlessSessionConfig({}));
    assert.isFalse(yield* readHeadlessSessionConfig({ CI: "true" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_CONNECTION: "client server" }));
    assert.isTrue(yield* readHeadlessSessionConfig({ SSH_TTY: "/dev/pts/1" }));
  }),
);

it.effect("treats cancelling optional background setup as a successful skip", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(Effect.fail(new Terminal.QuitError({})));
    assert.equal(result, "skipped");
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.equal(result, "skipped");
  }),
);

it.effect("reports pending onboarding until the handed-off service is ready", () =>
  Effect.gen(function* () {
    const input = yield* Queue.make<Terminal.UserInput>();
    yield* Queue.offer(input, {
      input: Option.some("\r"),
      key: { name: "return", ctrl: false, meta: false, shift: false },
    });
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.succeed(Queue.asDequeue(input)),
      readLine: Effect.die("unexpected line input"),
      display: () => Effect.void,
    });
    const plan = {
      program: ["/test/t3", "__service-launcher"],
      baseDir: "/test",
      unitPath: "/test/t3code.service",
      logPath: "/test/boot-service.log",
      handedOff: true,
    };
    let current = false;
    const service = BootService.BootService.of({
      status: Effect.sync(() => ({
        supported: true,
        installed: true,
        current,
        unitPath: plan.unitPath,
        logPath: plan.logPath,
      })),
      install: () => Effect.succeed(plan),
      restart: Effect.die("unexpected restart"),
      uninstall: Effect.die("unexpected uninstall"),
      withStopped: () => Effect.die("unexpected maintenance"),
    });
    const lines: string[] = [];
    const onboard = recoverServiceOnboardingOffer(offerServiceDuringOnboarding).pipe(
      Effect.flatMap(reportServiceOnboarding),
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (...args) => {
          lines.push(args.map(String).join(" "));
        },
      }),
    );

    yield* onboard;
    const output = lines.join("\n");
    assert.notInclude(output, "Background service ready");
    assert.notInclude(output, "Start the server");
    assert.include(output, "Background service restarting");
    assert.include(output, plan.logPath);

    current = true;
    lines.length = 0;
    yield* onboard;
    assert.include(lines.join("\n"), "Background service ready");
    assert.notInclude(lines.join("\n"), "restarting");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.effect("installs the relay client after the user accepts the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const progress: Array<string> = [];
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: (report) =>
          report({ type: "progress", stage: "downloading" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                installCalls += 1;
                return managedExecutable;
              }),
            ),
          ),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(true),
      (event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(installCalls, 1);
    assert.deepEqual(progress, ["downloading"]);
  }),
);

it.effect("reuses an available relay client executable without prompting", () =>
  Effect.gen(function* () {
    let promptCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed(managedExecutable),
        install: Effect.die("unexpected install"),
        installWithProgress: () => Effect.die("unexpected install"),
        pruneManagedVersions: Effect.void,
      },
      () =>
        Effect.sync(() => {
          promptCalls += 1;
          return false;
        }),
      () => Effect.void,
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(promptCalls, 0);
  }),
);

it.effect("keeps disconnect causes in structured logs and out of console warnings", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;
  const logger = Logger.make(({ fiber }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const liveFailure = "live unlink private diagnostic";
  const relayFailure = "relay revoke private diagnostic";

  return reportCloudDisconnectResults({
    clearAuthorization: true,
    liveResult: {
      status: "failed",
      cause: Cause.fail(new Error(liveFailure)),
    },
    relayResult: Exit.failCause(Cause.die(new Error(relayFailure))),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.lengthOf(warnings, 2);
        const warningText = warnings.flat().map(String).join("\n");
        assert.include(warningText, "running server could not stop its tunnel");
        assert.include(warningText, "Could not revoke the relay-side environment record");
        assert.notInclude(warningText, liveFailure);
        assert.notInclude(warningText, relayFailure);
        assert.deepEqual(
          logs.map(({ operation, clearAuthorization }) => ({
            operation,
            clearAuthorization,
          })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            {
              operation: "relay-environment-unlink",
              clearAuthorization: true,
            },
          ],
        );
        const loggedCauses = logs.map((log) => String(log.cause)).join("\n");
        assert.include(loggedCauses, liveFailure);
        assert.include(loggedCauses, relayFailure);
      }),
    ),
  );
});

it.effect.each([
  "compatible",
  "incompatible",
  "cloudless",
  "malformed-logout",
  "missing-issuer-logout",
  "missing-stamp-logout",
  "missing-url-foreign-stamp",
] as const)(
  "deliberate %s CLI unlink preserves login and reports pending remote cleanup honestly",
  (admission) => {
    const values = new Map<string, Uint8Array>([
      [
        "cloud-relay-url",
        new TextEncoder().encode(
          admission === "compatible" ? "https://selected.example.test" : "https://old.example.test",
        ),
      ],
      [
        "cloud-relay-issuer",
        new TextEncoder().encode(
          admission === "compatible" ? "https://selected.example.test" : "https://old.example.test",
        ),
      ],
      ["cloud-linked-user-id", new TextEncoder().encode("old-user")],
      ["cloud-relay-environment-credential", new TextEncoder().encode("fixture-environment-token")],
      ["cloud-hold-webhooks-while-offline", new TextEncoder().encode("true")],
      ["cloud-cli-oauth-token", new TextEncoder().encode("preserved-cli-authorization")],
    ]);
    const logout = admission.endsWith("logout");
    if (admission === "missing-url-foreign-stamp") {
      values.delete("cloud-relay-url");
      values.set("cloud-relay-issuer", new TextEncoder().encode("https://selected.example.test"));
      values.set(
        "cloud-public-authority",
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            relayOrigin: "https://selected.example.test",
            cli: {
              version: 1,
              issuer: "https://foreign-clerk.example.test",
              tokenEndpointOrigin: "https://foreign-clerk.example.test",
              clientId: "foreign-client",
            },
          }),
        ),
      );
    }
    if (admission === "malformed-logout") {
      values.set(
        "cloud-relay-url",
        new TextEncoder().encode("https://user:sentinel@old.example.test/private"),
      );
      values.delete("cloud-relay-issuer");
    }
    if (admission === "missing-issuer-logout") values.delete("cloud-relay-url");
    if (admission === "missing-stamp-logout") {
      values.delete("cloud-relay-url");
      values.delete("cloud-relay-issuer");
      values.set(
        "cloud-public-authority",
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            relayOrigin: "https://old.example.test",
            cli: {
              version: 1,
              issuer: "https://old-clerk.example.test",
              tokenEndpointOrigin: "https://old-clerk.example.test",
              clientId: "old-client",
            },
          }),
        ),
      );
    }
    let requests = 0;
    return Effect.gen(function* () {
      yield* disconnectCloud({ clearAuthorization: logout });
      assert.equal(requests, admission === "compatible" ? 1 : 0);
      assert.isFalse(values.has("cloud-relay-url"));
      assert.isFalse(values.has("cloud-hold-webhooks-while-offline"));
      assert.isFalse(values.has("cloud-public-authority"));
      assert.equal(values.has("cloud-cli-oauth-token"), !logout);
      const pending = yield* readPendingRemoteCleanup;
      assert.equal(pending.length, admission === "compatible" ? 0 : 1);
      if (admission === "malformed-logout") assert.isNull(pending[0]?.relayOrigin);
      if (admission === "missing-issuer-logout" || admission === "missing-stamp-logout")
        assert.equal(pending[0]?.relayOrigin, "https://old.example.test");
      assert.notInclude(JSON.stringify(pending), "sentinel");
      if (admission === "missing-url-foreign-stamp") {
        assert.equal(pending[0]?.relayOrigin, "https://selected.example.test");
        // A second deliberate action with no surviving foreign material can clean up the reminder.
        yield* disconnectCloud({ clearAuthorization: false });
        assert.equal(requests, 1);
        assert.deepEqual(yield* readPendingRemoteCleanup, []);
      }
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/", {
          prefix: "t3-connect-disconnect-test-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.succeed(Option.fromNullishOr(values.get(name))),
          set: (name, bytes) =>
            Effect.sync(() => {
              values.set(name, bytes);
            }),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironmentIdentity,
        ServerEnvironment.ServerEnvironmentIdentity.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-one")),
        }),
      ),
      Effect.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
      Effect.provideService(
        CliTokenManager.CloudCliTokenManager,
        CliTokenManager.CloudCliTokenManager.of({
          get: Effect.die("unexpected interactive login"),
          getExisting: Effect.succeedSome({
            accessToken: "matching-token",
            refreshToken: "matching-refresh",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            publicAuthority: {
              version: 1,
              issuer: "https://clerk.example.test",
              tokenEndpointOrigin: "https://clerk.example.test",
              clientId: "oauth_client_test",
            },
          }),
          hasCredential: Effect.succeed(true),
          store: () => Effect.die("unused"),
          clear: Effect.sync(() => {
            values.delete("cloud-cli-oauth-token");
          }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests++;
            assert.equal(
              request.url,
              "https://selected.example.test/v1/client/environment-links/env-one",
            );
            assert.equal(request.method, "DELETE");
            return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
          }),
        ),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_CONNECT_MODE: admission === "cloudless" || logout ? "cloudless" : "owned",
              T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
              T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
              T3CODE_CLERK_JWT_TEMPLATE: "connect",
              T3CODE_RELAY_URL: "https://selected.example.test",
              T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
            },
          }),
        ),
      ),
    );
  },
);

/** Captures console lines from a successful local disconnect report. */
const captureDisconnectReport = (input: {
  readonly clearAuthorization: boolean;
  readonly liveResult: {
    readonly status: "succeeded";
  };
  readonly relayResult: Exit.Exit<
    { readonly status: "not-authenticated" } | { readonly status: "revoked" },
    unknown
  >;
}) => {
  const lines: Array<{
    readonly stream: "log" | "warn";
    readonly text: string;
  }> = [];
  const testConsole = {
    ...globalThis.console,
    log: (...args: ReadonlyArray<unknown>) => {
      lines.push({ stream: "log", text: args.map(String).join(" ") });
    },
    warn: (...args: ReadonlyArray<unknown>) => {
      lines.push({ stream: "warn", text: args.map(String).join(" ") });
    },
  } satisfies Console.Console;

  return reportCloudDisconnectResults(input).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(
      Logger.layer([Logger.make(() => undefined)], {
        mergeWithExisting: false,
      }),
    ),
    Effect.as(lines),
  );
};

it.effect("warns to deregister when unlink has no stored CLI authorization", () =>
  Effect.gen(function* () {
    const lines = yield* captureDisconnectReport({
      clearAuthorization: false,
      liveResult: { status: "succeeded" },
      relayResult: Exit.succeed({ status: "not-authenticated" }),
    });

    assert.deepEqual(
      lines.map((line) => line.stream),
      ["log", "warn"],
    );
    assert.equal(lines[0]?.text, "Arcwright Connect is disabled locally.");
    assert.include(lines[1]?.text, "The relay-side environment record was not revoked.");
    assert.include(lines[1]?.text, "Arcwright Connect page of your T3 account");
    assert.include(lines[1]?.text, "`t3 connect login`");
    assert.notInclude(lines.map((line) => line.text).join("\n"), "Revoked the relay-side");
  }),
);

it.effect("points a failed relay unlink at retry and account deregistration", () =>
  Effect.gen(function* () {
    const lines = yield* captureDisconnectReport({
      clearAuthorization: false,
      liveResult: { status: "succeeded" },
      relayResult: Exit.fail("relay unreachable"),
    });
    const warning = lines.find((line) => line.stream === "warn")?.text ?? "";

    assert.equal(lines[0]?.text, "Arcwright Connect is disabled locally.");
    assert.include(warning, "Run `t3 connect unlink` again when the relay is reachable");
    assert.include(warning, "deregister it from the Arcwright Connect page of your T3 account");
    assert.notInclude(warning, "relay unreachable");
  }),
);
