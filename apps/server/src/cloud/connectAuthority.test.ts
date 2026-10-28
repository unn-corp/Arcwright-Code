import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Terminal from "effect/Terminal";
import * as Queue from "effect/Queue";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { cliAuthorityFromMetadata, classifyRelayAuthority } from "./connectAuthority.ts";
import {
  readRelayConnection,
  readAgentActivityPublishingActive,
  RELAY_URL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
} from "./config.ts";

const ownedEnv = {
  T3CODE_CONNECT_MODE: "owned",
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  T3CODE_CLERK_JWT_TEMPLATE: "connect",
  T3CODE_RELAY_URL: "https://relay.example.test",
  T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
};
const stamp = cliAuthorityFromMetadata({
  tokenEndpoint: "https://clerk.example.test/oauth/token",
  clientId: "oauth_client_test",
});
const fixtureToken: CliTokenManager.PersistedToken = {
  accessToken: "saved-access",
  refreshToken: "saved-refresh",
  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  identity: "operator@example.test",
};
function memoryStore(initial: ReadonlyArray<readonly [string, string]> = []) {
  const values = new Map<string, Uint8Array>(
    initial.map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  return { values, store };
}
const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.layer(NodeServices.layer)("persisted CLI authority", (it) => {
  const cases = (["owned", "cloudless", "legacy"] as const).flatMap((mode) =>
    (["unbound", "foreign", "compatible"] as const).flatMap((credential) =>
      [false, true].map((expired) => ({ mode, credential, expired })),
    ),
  );
  it.effect.each(cases)(
    "$mode $credential expired=$expired admission preserves rejected state",
    ({ mode, credential, expired }) =>
      Effect.gen(function* () {
        const token = {
          ...fixtureToken,
          expiresAtEpochMs: expired ? 0 : Number.MAX_SAFE_INTEGER,
          ...(credential === "unbound"
            ? {}
            : {
                publicAuthority:
                  credential === "compatible" ? stamp : { ...stamp, clientId: "foreign-client" },
              }),
        };
        const encoded = JSON.stringify(token);
        const { store, values } = memoryStore([["cloud-cli-oauth-token", encoded]]);
        const requests: string[] = [];
        const inputs = yield* Queue.make<Terminal.UserInput>();
        const terminal = Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          readInput: Effect.succeed(Queue.asDequeue(inputs)),
          readLine: Effect.never,
          display: () => Effect.void,
        });
        const manager = yield* CliTokenManager.make.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, store),
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provideService(
            ExternalLauncher.ExternalLauncher,
            ExternalLauncher.ExternalLauncher.of({
              resolveAvailableEditors: () => Effect.succeed([]),
              resolveFileManagerRevealKind: () => Effect.sync(() => undefined),
              launchBrowser: () => Effect.die("unexpected browser"),
              launchEditor: () => Effect.die("unused"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(request.url);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: "fresh-access",
                    refresh_token: "fresh-refresh",
                    expires_in: 3600,
                    token_type: "bearer",
                  }),
                );
              }),
            ),
          ),
        );
        const acceptable =
          mode !== "cloudless" &&
          (credential === "compatible" || (mode === "legacy" && credential === "unbound"));
        assert.equal(yield* manager.hasCredential, acceptable);
        const result = yield* manager.getExisting;
        assert.equal(Option.isSome(result), acceptable);
        assert.equal(requests.length, acceptable && expired ? 1 : 0);
        if (!acceptable)
          assert.equal(new TextDecoder().decode(values.get("cloud-cli-oauth-token")), encoded);
        if (acceptable && expired) {
          assert.equal(Option.getOrThrow(result).identity, fixtureToken.identity);
          assert.deepEqual(Option.getOrThrow(result).publicAuthority, stamp);
        }
        if (mode === "cloudless") {
          const error = yield* Effect.flip(manager.get);
          assert.include(error.message, "disabled in cloudless mode");
          assert.equal(requests.length, 0);
        }
        // Public store does not bless a foreign or old unbound token.
        yield* manager.store(token);
        assert.equal(yield* manager.hasCredential, acceptable);
      }).pipe(
        provideEnv(
          mode === "legacy" && credential === "unbound" && !expired
            ? {}
            : { ...ownedEnv, T3CODE_CONNECT_MODE: mode },
        ),
      ),
  );
});

it.layer(NodeServices.layer)("deliberate selected authorization", (it) => {
  it.effect.each([true, false])(
    "stamps code exchange and replaces old state only on %s",
    (success) =>
      Effect.gen(function* () {
        const loopbackClient = yield* HttpClient.HttpClient.pipe(
          Effect.provide(FetchHttpClient.layer),
        );
        const encoded = JSON.stringify(fixtureToken);
        const { store, values } = memoryStore([["cloud-cli-oauth-token", encoded]]);
        const queue = yield* Queue.make<Terminal.UserInput>();
        yield* Queue.offer(queue, {
          input: Option.some("enter"),
          key: { name: "enter", ctrl: false, meta: false, shift: false },
        });
        const manager = yield* CliTokenManager.make.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, store),
          Effect.provideService(
            Terminal.Terminal,
            Terminal.make({
              columns: Effect.succeed(80),
              rows: Effect.succeed(24),
              readInput: Effect.succeed(Queue.asDequeue(queue)),
              readLine: Effect.never,
              display: () => Effect.void,
            }),
          ),
          Effect.provideService(
            ExternalLauncher.ExternalLauncher,
            ExternalLauncher.ExternalLauncher.of({
              resolveAvailableEditors: () => Effect.succeed([]),
              resolveFileManagerRevealKind: () => Effect.sync(() => undefined),
              launchEditor: () => Effect.die("unused"),
              launchBrowser: (url) =>
                Effect.gen(function* () {
                  const authorization = readConnectAuthorizeRequest(new URL(url));
                  assert.isNotNull(authorization);
                  const response = yield* loopbackClient.get(
                    `http://127.0.0.1:${authorization!.loopbackPort}/callback?state=${encodeURIComponent(authorization!.state)}&code=selected-code`,
                  );
                  assert.equal(response.status, 200);
                }).pipe(Effect.orDie),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                assert.equal(request.url, "https://clerk.example.test/oauth/token");
                assert.equal(request.body._tag, "Uint8Array");
                const params = new URLSearchParams(
                  new TextDecoder().decode(
                    request.body._tag === "Uint8Array" ? request.body.body : undefined,
                  ),
                );
                assert.equal(params.get("grant_type"), "authorization_code");
                assert.equal(params.get("code"), "selected-code");
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    success
                      ? {
                          access_token: "new-code-token",
                          refresh_token: "new-code-refresh",
                          expires_in: 3600,
                          token_type: "bearer",
                        }
                      : { error: "invalid_grant" },
                    { status: success ? 200 : 400 },
                  ),
                );
              }),
            ),
          ),
        );
        if (success) {
          const result = yield* manager.get;
          assert.equal(result._tag, "Authorized");
          if (result._tag === "Authorized") assert.deepEqual(result.token.publicAuthority, stamp);
          assert.equal(yield* manager.hasCredential, true);
        } else {
          yield* Effect.flip(manager.get);
          assert.equal(new TextDecoder().decode(values.get("cloud-cli-oauth-token")), encoded);
        }
      }).pipe(Effect.scoped, provideEnv(ownedEnv)),
  );
});

it.effect(
  "relay admission normalizes origins and rejects a foreign issuer on the selected URL",
  () =>
    Effect.gen(function* () {
      const selected = {
        mode: "owned",
        relayOrigin: "https://relay.example.test",
        cli: stamp,
      } as const;
      assert.equal(
        classifyRelayAuthority(selected, { relayUrl: "https://relay.example.test///" }),
        "active",
      );
      assert.equal(
        classifyRelayAuthority(selected, {
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://old.example.test",
        }),
        "incompatible",
      );
      const publicAuthority = {
        version: 1,
        relayOrigin: selected.relayOrigin,
        cli: { ...stamp, clientId: "old-client" },
      } as const;
      assert.equal(
        classifyRelayAuthority(selected, { relayUrl: selected.relayOrigin, publicAuthority }),
        "incompatible",
      );
      assert.equal(
        classifyRelayAuthority(
          { mode: "legacy", relayOrigin: selected.relayOrigin, cli: stamp },
          { relayUrl: selected.relayOrigin, publicAuthority },
        ),
        "incompatible",
      );
      assert.equal(
        classifyRelayAuthority({ mode: "legacy" }, { relayUrl: "https://old.example.test" }),
        "active",
      );
      const { store } = memoryStore([
        [RELAY_URL_SECRET, "https://old.example.test"],
        [RELAY_ISSUER_SECRET, "https://old.example.test"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "saved-env-token"],
        [PUBLISH_AGENT_ACTIVITY_SECRET, "true"],
      ]);
      assert.isNull(
        yield* readRelayConnection.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        ),
      );
      assert.isFalse(yield* readAgentActivityPublishingActive(store));
    }).pipe(provideEnv(ownedEnv)),
);
