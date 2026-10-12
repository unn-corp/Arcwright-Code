import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { readPendingRemoteCleanup } from "../cloud/pendingRemoteCleanup.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Terminal from "effect/Terminal";

import * as BootService from "../cloud/bootService.ts";
import {
  disconnectCloud,
  acquireRelayClientForLink,
  headlessSessionConfig,
  reportCloudDisconnectResults,
} from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";

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
    assert.isFalse(result);
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.isFalse(result);
  }),
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
          logs.map(({ operation, clearAuthorization }) => ({ operation, clearAuthorization })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            { operation: "relay-environment-unlink", clearAuthorization: true },
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
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/", { prefix: "t3-connect-disconnect-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
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
