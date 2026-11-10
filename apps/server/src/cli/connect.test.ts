import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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

// @effect-diagnostics-next-line nodeBuiltinImport:off -- socket fixture
import * as NodeHttp from "node:http";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NetService from "@t3tools/shared/Net";
import { afterEach, vi } from "vite-plus/test";

import { disconnectCloud, connectCommand, acquireRelayClientForLink } from "./connect.ts";

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
          NodeCrypto.layer,
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
import { makeCli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

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

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect unlink",
  (it) => {
    const runUnlink = (recordedPid: number, options?: { readonly portFreed?: boolean }) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return { requests, warnings, printed: (yield* TestConsole.logLines).join("\n") };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(printed, "Arcwright Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runUnlink(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runUnlink(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runUnlink(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "Arcwright Connect is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);
