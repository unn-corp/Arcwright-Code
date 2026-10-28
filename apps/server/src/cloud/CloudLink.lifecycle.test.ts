import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The owned link fixture needs a real Ed25519 public key.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { EnvironmentId } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import { writeServiceState } from "../serviceLauncher.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { RelayManagedEndpointRecoveryRegistrationRequest } from "@t3tools/contracts/relay";
import {
  CLOUD_PUBLIC_AUTHORITY_SECRET,
  CLOUD_LOCAL_DISABLED_SECRET,
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  decodeRuntimeConfig,
  readPersistedRelayAuthorityStatus,
  readAgentActivityPublishingActive,
  readRelayConnection,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { readPendingRemoteCleanup, rememberPendingRemoteCleanup } from "./pendingRemoteCleanup.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { consumeCloudReplayGuards } from "./CloudLink.ts";
import { pendingServiceUpdateExists } from "./updateHandoff.ts";
import { managedTunnelStartupAction } from "./managedTunnelStartup.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "cloud replay guard",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "cloud-replay-guard.bin",
    }),
  });

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

const idleAwarenessRelay = AgentAwarenessRelay.AgentAwarenessRelay.of({
  publishThread: () => Effect.void,
  drain: Effect.void,
  requestCatchUp: () => Effect.void,
  start: () => Effect.void,
});

const idleHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const decodeManagedTunnelRecoveryRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayManagedEndpointRecoveryRegistrationRequest),
);

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

describe("consumeCloudReplayGuards", () => {
  it.effect("reports already-created guards as replay conflicts", () =>
    Effect.gen(function* () {
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.fail(storeFailure("AlreadyExists"))),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
    }),
  );
});

describe("releaseManagedTunnelOnShutdown", () => {
  const cliToken: CliTokenManager.PersistedToken = {
    accessToken: "cli-access-token",
    refreshToken: "cli-refresh-token",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };

  function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
    const values = new Map<string, Uint8Array>(
      Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    };
    return { store, values };
  }

  interface ReleaseHarness {
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
    readonly applyConfigCalls: Array<unknown>;
    readonly requests: Array<HttpClientRequest.HttpClientRequest>;
    readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>;
    readonly respond?: () => Response;
    readonly address?: HttpServer.HttpServer["Service"]["address"];
    readonly respondEffect?: Effect.Effect<Response>;
    readonly getExisting?: CliTokenManager.CloudCliTokenManager["Service"]["getExisting"];
  }

  const writeLauncherState = (update: ServiceUpdateRecord) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      const statePath = path.join(config.baseDir, "runtime", SERVICE_STATE_FILE);
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "0.0.30",
          update,
        }),
      );
    });

  const provideReleaseHarness =
    (harness: ReleaseHarness) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(CloudLink.layer),
        Effect.provideService(
          ConnectReachability.ConnectReachability,
          ConnectReachability.ConnectReachability.of({
            check: Effect.die("unused"),
            latest: Effect.succeedNone,
          }),
        ),
        Effect.provideService(HttpServer.HttpServer, {
          ...idleHttpServer,
          address: harness.address ?? idleHttpServer.address,
        }),
        Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
        Effect.provideService(AgentAwarenessRelay.AgentAwarenessRelay, idleAwarenessRelay),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provideService(
          ManagedEndpointRuntime.CloudManagedEndpointRuntime,
          ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: (config) =>
              Effect.sync(() => {
                harness.applyConfigCalls.push(config);
                return config === null
                  ? ({
                      status: "disabled",
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus)
                  : ({
                      status: "running",
                      providerKind: "cloudflare_tunnel",
                      pid: 123,
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus);
              }),
            recoveryRequests: Stream.empty,
            requestRecovery: () => Effect.void,
            tunnelConnected: Stream.empty,
            inspectConnector: Effect.succeed(null),
            readinessChanged: Stream.empty,
            withLinkStateLock: (effect) => effect,
          }),
        ),
        Effect.provideService(
          EnvironmentAuth.EnvironmentAuth,
          EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Effect.provideService(
          CliTokenManager.CloudCliTokenManager,
          CliTokenManager.CloudCliTokenManager.of({
            get: unusedSecretStoreOperation(),
            getExisting: harness.getExisting ?? Effect.succeedSome(cliToken),
            hasCredential: unusedSecretStoreOperation(),
            store: () => unusedSecretStoreOperation(),
            clear: unusedSecretStoreOperation(),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              harness.requests.push(request);
            }).pipe(
              Effect.andThen(harness.onRequest?.(request) ?? Effect.void),
              Effect.andThen(
                harness.respondEffect ??
                  Effect.sync(() => (harness.respond ?? (() => Response.json({ ok: true })))()),
              ),
              Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        ),

        Effect.provide(
          ServerConfigModule.layerTest("/", { prefix: "t3-http-release-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      );

  const managedLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
  ] as const;

  it.effect("does not recreate a link that was unlinked while startup registration retried", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;

      values.delete(CLOUD_CLI_DESIRED_LINK_SECRET);

      expect(yield* link.reconcileDesiredLinkIfStillDesired("http://127.0.0.1:3773")).toBeNull();
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("stops the connector, releases the relay tunnel, and drops the dead token", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(applyConfigCalls).toEqual([null]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe(
        "https://relay.example.test/v1/client/environment-links/env_123/tunnel",
      );
      expect(request.headers.authorization).toBe("Bearer cli-access-token");
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
      expect(values.has(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("leaves the tunnel of a web/mobile-installed link untouched", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps the tunnel when shutdown hands off to a pending update", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });

      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("still releases a pending update when the launcher is stopping", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      yield* fs.writeFileString(path.join(config.baseDir, "runtime", SERVICE_STOP_MARKER_FILE), "");

      expect(yield* pendingServiceUpdateExists).toBe(true);
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  // regression: 808d6853555 keep the managed tunnel across remote update restarts
  it.effect("still releases when the recorded update already settled", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        status: "committed",
      });

      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps a runtime config that a fast restart replaced mid-release", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const freshConfig = new TextEncoder().encode("fresh-runtime-config");

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);

      expect(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(freshConfig);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => {
          values.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, freshConfig);
          return Response.json({ ok: true });
        },
      }),
    );
  });

  it.effect("keeps the stored connector token when the relay skipped the release", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ ok: false }),
      }),
    );
  });

  it.effect("registers an existing tunnel and starts the confirmed connector", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toMatchObject({
        status: "ready",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/env_123/tunnel/recovery",
      );
      expect(requests[0]?.headers.authorization).toBe("Bearer environment-credential");
      const body = requests[0]?.body;
      expect(body?._tag).toBe("Uint8Array");
      if (body?._tag === "Uint8Array") {
        expect(
          yield* decodeManagedTunnelRecoveryRegistration(new TextDecoder().decode(body.body)),
        ).toMatchObject({
          cloudUserId: "user-123",
          tunnelId: "existing-tunnel",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });
      }
      expect(applyConfigCalls).toHaveLength(1);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ status: "ready" }),
      }),
    );
  });

  it.effect("registers and starts a managed tunnel at the bound IPv6 loopback address", () => {
    const { store } = makeMemorySecretStore();
    const config = {
      providerKind: "cloudflare_tunnel" as const,
      connectorToken: "existing-token",
      tunnelId: "existing-tunnel",
    };
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(
        yield* link.applyRelayConfig({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user-123",
          environmentCredential: "environment-credential",
          cloudMintPublicKey:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqZ2u2LjMoAyG2QTHXmITJ9w6RzZtVUAv394XCcPV0zE=\n-----END PUBLIC KEY-----",
          endpointRuntime: config,
        }),
      ).toMatchObject({ ok: true, endpointRuntimeStatus: { status: "running" } });
      expect(requests).toHaveLength(1);
      const body = requests[0]!.body;
      if (body._tag !== "Uint8Array") throw new Error("Expected a JSON recovery request");
      expect(
        yield* decodeManagedTunnelRecoveryRegistration(new TextDecoder().decode(body.body)),
      ).toMatchObject({
        origin: { localHttpHost: "[::1]", localHttpPort: 4884 },
      });
      expect(applyConfigCalls).toEqual([null, config]);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        address: NetAddress.inetAddressFromIpStringUnsafe("::1", 4884),
        respond: () => Response.json({ status: "ready" }),
      }),
    );
  });

  it.effect("marks a link the relay rejects as revoked without dropping or replacing it", () => {
    const { store, values } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
        status: "revoked",
      });
      expect((yield* link.linkState()).linkRevoked).toBe(true);

      expect(requests).toHaveLength(1);
      expect(applyConfigCalls).toEqual([]);
      expect(values.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(true);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: "trace-revoked",
            },
            { status: 401 },
          ),
      }),
    );
  });

  it.effect("does not mark a link that was replaced while its rejection was in flight", () => {
    const { store, values } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
    ]);

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
        status: "superseded",
      });
      expect(values.has(CLOUD_LINK_REVOKED)).toBe(false);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls: [],
        requests: [],
        respond: () => {
          values.set(
            RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
            new TextEncoder().encode("replacement-credential"),
          );
          return Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: "trace-stale",
            },
            { status: 401 },
          );
        },
      }),
    );
  });

  it.effect("clears the revoked mark when the environment is linked again", () => {
    const { store } = makeMemorySecretStore([
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "revoked-credential"],
      [CLOUD_LINK_REVOKED, "true"],
    ]);
    const cloudMintPublicKey =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqZ2u2LjMoAyG2QTHXmITJ9w6RzZtVUAv394XCcPV0zE=\n-----END PUBLIC KEY-----";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect((yield* link.linkState()).linkRevoked).toBe(true);
      yield* link.applyRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user-123",
        environmentCredential: "fresh-credential",
        cloudMintPublicKey,
        endpointRuntime: null,
      });
      expect(yield* link.linkState()).toMatchObject({ linked: true, linkRevoked: false });
    }).pipe(provideReleaseHarness({ store, applyConfigCalls: [], requests: [] }));
  });

  it.effect(
    "starts a connector with a marker for the current origin without contacting relay",
    () => {
      const configJson =
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}';
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "existing-token",
        tunnelId: "existing-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, configJson],
        [
          CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
          `{"config":${configJson},"origin":{"localHttpHost":"127.0.0.1","localHttpPort":3773}}`,
        ],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773")).toBe(true);
        expect(applyConfigCalls).toEqual([config]);
        expect(requests).toEqual([]);
      }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
    },
  );

  it.effect.each([
    { name: "missing", marker: undefined, origin: "http://127.0.0.1:3773" },
    {
      name: "stale",
      marker:
        '{"config":{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"},"origin":{"localHttpHost":"127.0.0.1","localHttpPort":3773}}',
      origin: "http://127.0.0.1:4884",
    },
  ])("does not start a connector with a $name origin marker", ({ marker, origin }) => {
    const entries: Array<readonly [string, string]> = [
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
    ];
    if (marker !== undefined) entries.push([CLOUD_ENDPOINT_CONFIRMED_ORIGIN, marker]);
    const { store } = makeMemorySecretStore(entries);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.startManagedTunnelIfOriginConfirmed(origin)).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  // regression: #9386 remove tunnels after hosts go offline
  it.effect(
    "starts the stored connector without a marker when confirmation is not required",
    () => {
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "existing-token",
        tunnelId: "existing-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(config)],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(
          yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773", {
            requireConfirmedOrigin: false,
          }),
        ).toBe(true);
        expect(applyConfigCalls).toEqual([config]);
        expect(requests).toEqual([]);
      }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
    },
  );

  it.effect.each(["replaced", "removed"] as const)(
    "does not activate a tunnel when its runtime config is %s during registration",
    (mutation) => {
      const originalConfig =
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}';
      const { store, values } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, originalConfig],
        [RELAY_URL_SECRET, "https://relay.example.test"],
        [CLOUD_LINKED_USER_ID, "user-123"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
          status: "superseded",
        });
        expect(applyConfigCalls).toEqual([]);
        expect(values.has(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)).toBe(false);
      }).pipe(
        provideReleaseHarness({
          store,
          applyConfigCalls,
          requests,
          respond: () => {
            if (mutation === "replaced") {
              values.set(
                CLOUD_ENDPOINT_RUNTIME_CONFIG,
                new TextEncoder().encode(
                  '{"providerKind":"cloudflare_tunnel","connectorToken":"fresh-token","tunnelId":"fresh-tunnel"}',
                ),
              );
            } else {
              values.delete(CLOUD_ENDPOINT_RUNTIME_CONFIG);
            }
            return Response.json({ status: "ready" });
          },
        }),
      );
    },
  );

  it.effect("requests startup recovery for a legacy config without a recorded tunnel ID", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"token"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const registration = yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773");
      expect(registration).toEqual({
        status: "recovery_required",
        config: { providerKind: "cloudflare_tunnel", connectorToken: "token" },
      });
      expect(
        managedTunnelStartupAction({
          wantsCliLink: false,
          registration,
        }),
      ).toEqual({
        action: "request_recovery",
        config: { providerKind: "cloudflare_tunnel", connectorToken: "token" },
      });
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("recovers a web-linked tunnel and clears its revoked mark", () => {
    const oldConfig =
      '{"providerKind":"cloudflare_tunnel","connectorToken":"old-token","tunnelId":"old-tunnel"}';
    const nextConfig = {
      providerKind: "cloudflare_tunnel",
      connectorToken: "new-token",
      tunnelId: "new-tunnel",
    } as const;
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, oldConfig],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      [CLOUD_LINK_REVOKED, "true"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("https://relay.example.test/v1/environments/env_123/tunnel");
      expect(requests[0]?.headers.authorization).toBe("Bearer environment-credential");
      expect(applyConfigCalls).toEqual([nextConfig]);
      expect(
        Option.getOrNull(
          decodeRuntimeConfig(new TextDecoder().decode(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG))),
        ),
      ).toEqual(nextConfig);
      expect(values.has(CLOUD_LINK_REVOKED)).toBe(false);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json({
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: nextConfig,
          }),
      }),
    );
  });

  it.effect("does not recover an environment without a managed tunnel credential", () => {
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("ignores recovery requests for a tunnel that has already been replaced", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"current-token","tunnelId":"current-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(
        yield* link.recoverManagedTunnel("http://127.0.0.1:3773", {
          providerKind: "cloudflare_tunnel",
          connectorToken: "old-token",
          tunnelId: "old-tunnel",
        }),
      ).toBe(false);
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect.each([
    {
      status: 401,
      body: {
        _tag: "RelayAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_bearer",
        traceId: "trace-revoked",
      },
      rejection: "unauthorized",
    },
    { status: 403, body: {}, rejection: "forbidden" },
    { status: 409, body: {}, rejection: "rejected" },
  ])("preserves a permanent $status relay recovery failure", ({ status, body, rejection }) => {
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(link.recoverManagedTunnel("http://127.0.0.1:3773"));

      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection });
      expect(CloudLink.shouldRetryCloudLink(error)).toBe(false);
      expect(requests).toHaveLength(1);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json(body, { status }),
      }),
    );
  });

  it.effect("retries a relay link proof rejected as expired", () => {
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(link.recoverManagedTunnel("http://127.0.0.1:3773"));

      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
      expect(error.message).toContain("Trace ID: trace-expired");
      expect(CloudLink.shouldRetryCloudLink(error)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json(
            {
              _tag: "RelayEnvironmentLinkProofExpiredError",
              code: "environment_link_proof_expired",
              traceId: "trace-expired",
            },
            { status: 401 },
          ),
      }),
    );
  });

  it.effect("keeps a tunnel configuration replaced during recovery", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const freshConfig = new TextEncoder().encode("fresh-config");

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
      expect(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(freshConfig);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => {
          values.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, freshConfig);
          return Response.json({
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "replacement-token",
            },
          });
        },
      }),
    );
  });

  it.effect(
    "actual applyRelayConfig waits at leastRetryAfter before retrying recovery registration429",
    () => {
      const { store } = makeMemorySecretStore();
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        return yield* Effect.gen(function* () {
          const link = yield* CloudLink.CloudLink;
          const keys = NodeCrypto.generateKeyPairSync("ed25519", {
            publicKeyEncoding: { format: "pem", type: "spki" },
            privateKeyEncoding: { format: "pem", type: "pkcs8" },
          });
          const fiber = yield* link
            .applyRelayConfig({
              relayUrl: "https://relay.example.test",
              relayIssuer: "https://relay.example.test",
              cloudUserId: "user-123",
              environmentCredential: "synthetic-environment-credential",
              cloudMintPublicKey: keys.publicKey,
              endpointRuntime: {
                providerKind: "cloudflare_tunnel",
                tunnelId: "synthetic-tunnel",
                connectorToken: "synthetic-connector",
              },
            })
            .pipe(Effect.forkChild);
          // HttpClient responds through a barrier only after the actual caller issues its first request.
          yield* Deferred.await(first);
          yield* TestClock.adjust("59 seconds");
          expect(requests).toHaveLength(1);
          yield* TestClock.adjust("1 second");
          expect((yield* Fiber.join(fiber)).ok).toBe(true);
          expect(requests).toHaveLength(2);
        }).pipe(
          provideReleaseHarness({
            store,
            applyConfigCalls,
            requests,
            onRequest: () => Deferred.succeed(first, undefined),
            respond: () =>
              requests.length === 1
                ? Response.json(
                    {
                      _tag: "RelayRateLimitExceededError",
                      code: "relay_rate_limited",
                      retryAfterSeconds: 60,
                      traceId: "synthetic-rate-trace",
                    },
                    { status: 429, headers: { "retry-after": "60" } },
                  )
                : Response.json({ status: "ready" }),
          }),
        );
      });
    },
  );

  it.effect(
    "installs an owned fresh link with an OAuth authority stamp and refuses another realm on the same relay",
    () => {
      const { store, values } = makeMemorySecretStore();
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const publicKey = NodeCrypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { format: "pem", type: "spki" },
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
      }).publicKey;
      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        yield* link.applyRelayConfig({
          relayUrl: "https://selected.example.test",
          relayIssuer: "https://selected.example.test",
          cloudUserId: "selected-user",
          environmentCredential: "selected-environment-token",
          cloudMintPublicKey: publicKey,
          endpointRuntime: null,
        });
        expect((yield* link.linkState()).authorityStatus).toBe("active");
        expect(values.has(CLOUD_PUBLIC_AUTHORITY_SECRET)).toBe(true);
        expect(
          yield* readPersistedRelayAuthorityStatus(store, {
            mode: "owned",
            relayOrigin: "https://selected.example.test",
            cli: {
              version: 1,
              issuer: "https://clerk.example.test",
              tokenEndpointOrigin: "https://clerk.example.test",
              clientId: "another-client",
            },
          }),
        ).toBe("incompatible");
        expect(requests).toEqual([]);
        yield* store.set(CLOUD_LOCAL_DISABLED_SECRET, new TextEncoder().encode("true"));
        const bad = yield* Effect.flip(
          link.applyRelayConfig({
            relayUrl: "https://selected.example.test",
            relayIssuer: "https://old.example.test",
            cloudUserId: "selected-user",
            environmentCredential: "replacement-token",
            cloudMintPublicKey: publicKey,
            endpointRuntime: null,
          }),
        );
        expect(bad._tag).toBe("CloudLinkAuthorityUnavailableError");
        expect(values.has(CLOUD_LOCAL_DISABLED_SECRET)).toBe(true);
        expect(new TextDecoder().decode(values.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET))).toBe(
          "selected-environment-token",
        );
        yield* link.applyRelayConfig({
          relayUrl: "https://selected.example.test",
          relayIssuer: "https://selected.example.test",
          cloudUserId: "selected-user",
          environmentCredential: "selected-environment-token",
          cloudMintPublicKey: publicKey,
          endpointRuntime: null,
        });
        expect(values.has(CLOUD_LOCAL_DISABLED_SECRET)).toBe(false);
        expect((yield* link.linkState()).authorityStatus).toBe("active");
      }).pipe(
        provideReleaseHarness({ store, applyConfigCalls, requests }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_CONNECT_MODE: "owned",
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

  it.effect.each(["owned", "cloudless"] as const)(
    "keeps %s foreign links dormant through restore, recovery, proofs and shutdown",
    (mode) => {
      const { store, values } = makeMemorySecretStore([
        ...managedLinkSecrets,
        [
          CLOUD_ENDPOINT_RUNTIME_CONFIG,
          JSON.stringify({ providerKind: "cloudflare_tunnel", connectorToken: "old-tunnel-token" }),
        ],
        [CLOUD_LINKED_USER_ID, "old-account"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(
          yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773", {
            requireConfirmedOrigin: false,
          }),
        ).toBe(false);
        expect(yield* link.releaseManagedTunnelOnShutdown()).toBe(false);
        const attempts: ReadonlyArray<
          Effect.Effect<void, Effect.Error<ReturnType<typeof link.reconcileDesiredLink>>>
        > = [
          link.registerManagedTunnelRecovery("http://127.0.0.1:3773").pipe(Effect.asVoid),
          link.recoverManagedTunnel("http://127.0.0.1:3773").pipe(Effect.asVoid),
          link.reconcileDesiredLink("http://127.0.0.1:3773").pipe(Effect.asVoid),
        ];
        for (const effect of attempts) {
          const error = yield* Effect.flip(effect);
          expect(error._tag).toBe("CloudLinkAuthorityUnavailableError");
          expect(CloudLink.shouldRetryCloudLink(error)).toBe(false);
        }
        expect((yield* Effect.flip(link.answerHealthRequest({ proof: "old-proof" })))._tag).toBe(
          "CloudLinkAuthorityUnavailableError",
        );
        expect((yield* Effect.flip(link.mintCredential({ proof: "old-proof" })))._tag).toBe(
          "CloudLinkAuthorityUnavailableError",
        );
        const state = yield* link.linkState();
        expect(state.linked).toBe(true);
        expect(state.managedTunnelActive).toBe(false);
        expect(state.authorityStatus).toBe(mode === "owned" ? "incompatible" : "cloudless");
        expect(applyConfigCalls).toEqual([]);
        expect(requests).toEqual([]);
        expect(values.has(RELAY_URL_SECRET)).toBe(true);
        const result = yield* link.unlink();
        expect(result.remoteCleanupPending).toBe(true);
        expect(result.remoteCleanupAllowed).toBe(false);
        expect(values.has(RELAY_URL_SECRET)).toBe(false);
        expect((yield* link.linkState()).remoteCleanupPending).toBe(true);
        expect(requests).toEqual([]);
      }).pipe(
        provideReleaseHarness({ store, applyConfigCalls, requests }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_CONNECT_MODE: mode,
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
  const cleanupCases = (["owned", "cloudless"] as const).flatMap((mode) =>
    [
      "malformed",
      "missing-with-issuer",
      "malformed-with-issuer",
      "missing-with-stamp",
      "malformed-with-stamp",
      "malformed-with-invalid-stamp",
      "unknown-partial",
    ].map((shape) => ({ mode, shape })),
  );
  it.effect.each(cleanupCases)(
    "locally unlinks $mode $shape state without persisting unsafe URL material",
    ({ mode, shape }) => {
      const initial: Array<readonly [string, string]> = [
        [
          CLOUD_ENDPOINT_RUNTIME_CONFIG,
          JSON.stringify({ providerKind: "cloudflare_tunnel", connectorToken: "old-connector" }),
        ],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
        ["cloud-hold-webhooks-while-offline", "true"],
        ["provider-fixture", "untouched-provider"],
      ];
      if (shape.startsWith("malformed"))
        initial.push([
          RELAY_URL_SECRET,
          "https://user:sentinel-password@old.example.test/private?credential=sentinel",
        ]);
      if (shape.endsWith("issuer"))
        initial.push(["cloud-relay-issuer", "https://old.example.test/"]);
      if (shape === "missing-with-stamp" || shape === "malformed-with-stamp")
        initial.push([
          CLOUD_PUBLIC_AUTHORITY_SECRET,
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
        ]);
      if (shape === "malformed-with-invalid-stamp")
        initial.push([CLOUD_PUBLIC_AUTHORITY_SECRET, "invalid-sentinel-binding"]);
      const { store, values } = makeMemorySecretStore(initial);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        const before = yield* link.linkState();
        expect(before.linked).toBe(false);
        expect(before.persistedLinkPresent).toBe(true);
        expect(before.managedTunnelActive).toBe(false);
        const result = yield* link.unlink();
        expect(result.remoteCleanupPending).toBe(true);
        expect(result.remoteCleanupAllowed).toBe(false);
        expect(applyConfigCalls).toEqual([null]);
        expect(requests).toEqual([]);
        expect([...values.keys()]).toEqual(["provider-fixture"]);
        const references = yield* readPendingRemoteCleanup;
        expect(references).toHaveLength(1);
        expect(references[0]?.relayOrigin).toBe(
          shape.endsWith("issuer") ||
            shape === "missing-with-stamp" ||
            shape === "malformed-with-stamp"
            ? "https://old.example.test"
            : null,
        );
        expect(JSON.stringify(references)).not.toContain("sentinel");
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfigModule.ServerConfig;
        expect(
          yield* fs.readFileString(
            path.join(
              path.dirname(config.serverRuntimeStatePath),
              "connect-pending-remote-cleanup.json",
            ),
          ),
        ).not.toContain("sentinel");
        expect((yield* link.linkState()).remoteCleanupPending).toBe(true);
      }).pipe(
        provideReleaseHarness({ store, applyConfigCalls, requests }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_CONNECT_MODE: mode,
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

  it.effect(
    "confirms only a selected matching environment/service reference; unknown and other references remain",
    () => {
      const { store } = makeMemorySecretStore();
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        yield* rememberPendingRemoteCleanup({
          relayUrl: "https://selected.example.test",
          environmentId: "env_123",
        });
        yield* rememberPendingRemoteCleanup({
          relayUrl: "https://other.example.test",
          environmentId: "env_123",
        });
        yield* rememberPendingRemoteCleanup({ relayUrl: null, environmentId: "env_123" });
        yield* rememberPendingRemoteCleanup({
          relayUrl: "https://selected.example.test",
          environmentId: "other-env",
        });
        expect(
          (yield* Effect.flip(
            link.confirmRemoteCleanup({
              relayOrigin: "https://other.example.test",
              environmentId: EnvironmentId.make("env_123"),
            }),
          ))._tag,
        ).toBe("CloudLinkAuthorityUnavailableError");
        expect(
          (yield* Effect.flip(
            link.confirmRemoteCleanup({
              relayOrigin: "https://selected.example.test",
              environmentId: EnvironmentId.make("other-env"),
            }),
          ))._tag,
        ).toBe("CloudLinkAuthorityUnavailableError");
        expect(
          yield* link.confirmRemoteCleanup({
            relayOrigin: "https://selected.example.test",
            environmentId: EnvironmentId.make("env_123"),
          }),
        ).toEqual({ ok: true });
        expect(
          yield* link.confirmRemoteCleanup({
            relayOrigin: "https://selected.example.test",
            environmentId: EnvironmentId.make("env_123"),
          }),
        ).toEqual({ ok: false });
        const references = yield* readPendingRemoteCleanup;
        expect(references).toHaveLength(3);
        expect(references.some((reference) => reference.relayOrigin === null)).toBe(true);
        expect(requests).toEqual([]);
      }).pipe(
        provideReleaseHarness({ store, applyConfigCalls, requests }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_CONNECT_MODE: "owned",
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
  it.effect.each(
    (["owned", "cloudless"] as const).flatMap((mode) =>
      ["full", "corrupt", "locked"].map((shape) => ({ mode, shape })),
    ),
  )(
    "disables $mode locally while preserving credentials when cleanup reminders are $shape",
    ({ mode, shape }) => {
      const { store, values } = makeMemorySecretStore([
        [RELAY_URL_SECRET, "https://selected.example.test"],
        [CLOUD_LINKED_USER_ID, "old-user"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
        [CLOUD_MINT_PUBLIC_KEY, "old-mint-key"],
        [
          CLOUD_PUBLIC_AUTHORITY_SECRET,
          JSON.stringify({
            version: 1,
            relayOrigin: "https://selected.example.test",
            cli: {
              version: 1,
              issuer: "https://clerk.example.test",
              tokenEndpointOrigin: "https://clerk.example.test",
              clientId: "oauth_client_test",
            },
          }),
        ],
        [
          CLOUD_ENDPOINT_RUNTIME_CONFIG,
          JSON.stringify({
            providerKind: "cloudflare_tunnel",
            connectorToken: "old-runtime-token",
          }),
        ],
        ["cloud-publish-agent-activity", "true"],
        ["cloud-hold-webhooks-while-offline", "true"],
        [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
      ]);
      const original = new Map(values);
      original.delete(CLOUD_CLI_DESIRED_LINK_SECRET);
      original.set(CLOUD_LOCAL_DISABLED_SECRET, new TextEncoder().encode("true"));
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfigModule.ServerConfig;
        const directory = path.dirname(config.serverRuntimeStatePath);
        const reminderPath = path.join(directory, "connect-pending-remote-cleanup.json");
        const contents =
          shape === "corrupt"
            ? "not-json"
            : JSON.stringify(
                Array.from({ length: 16 }, (_, i) => ({
                  relayOrigin: `https://old-${i}.example.test`,
                  environmentId: `old-env-${i}`,
                  unlinkedAt: "2026-01-01T00:00:00.000Z",
                  status: "pending",
                })),
              );
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(reminderPath, contents);
        if (shape === "locked") yield* fs.makeDirectory(`${reminderPath}.lock`);
        const link = yield* CloudLink.CloudLink;
        const error = yield* Effect.flip(link.unlink());
        expect(error._tag).toBe("CloudLinkInternalError");
        expect(error.message).toContain("disabled locally");
        expect(applyConfigCalls).toEqual([null]);
        expect(values).toEqual(original);
        const disabledState = yield* link.linkState();
        expect(disabledState.locallyDisabled).toBe(true);
        expect(disabledState.remoteCleanupPending).toBe(true);
        expect(yield* fs.readFileString(reminderPath)).toBe(contents);
        expect(requests).toEqual([]);
        // Construct a new service over retained compatible records, as after a cold restart.
        yield* Effect.gen(function* () {
          const restarted = yield* CloudLink.CloudLink;
          expect(
            yield* restarted.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773", {
              requireConfirmedOrigin: false,
            }),
          ).toBe(false);
          for (const attempt of [
            restarted.reconcileDesiredLink("http://127.0.0.1:3773").pipe(Effect.asVoid),
            restarted.registerManagedTunnelRecovery("http://127.0.0.1:3773").pipe(Effect.asVoid),
            restarted.recoverManagedTunnel("http://127.0.0.1:3773").pipe(Effect.asVoid),
          ]) {
            const rejected = yield* Effect.flip(attempt);
            expect(rejected._tag).toBe("CloudLinkAuthorityUnavailableError");
            expect(rejected.message).toContain("disabled locally");
            expect(CloudLink.shouldRetryCloudLink(rejected)).toBe(false);
          }
          expect((yield* Effect.flip(restarted.mintCredential({ proof: "old-proof" })))._tag).toBe(
            "CloudLinkAuthorityUnavailableError",
          );
          expect(
            (yield* Effect.flip(restarted.answerHealthRequest({ proof: "old-proof" })))._tag,
          ).toBe("CloudLinkAuthorityUnavailableError");
          const state = yield* restarted.linkState();
          expect(state.locallyDisabled).toBe(true);
          expect(state.authorityStatus).toBe("unavailable");
          expect(state.managedTunnelActive).toBe(false);
          expect(state.publishAgentActivity).toBe(false);
          expect(yield* readAgentActivityPublishingActive(store)).toBe(false);
          expect(yield* readRelayConnection).toBe(null);
        }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
        expect(applyConfigCalls).toEqual([null]);
        expect(requests).toEqual([]);
        // Manual reminder repair followed by a deliberate retry can finish cleanup.
        if (shape === "locked") yield* fs.remove(`${reminderPath}.lock`, { recursive: true });
        yield* fs.writeFileString(reminderPath, "[]");
        yield* link.unlink();
        expect(values.size).toBe(0);
        expect((yield* link.linkState()).locallyDisabled).toBe(false);
        expect(applyConfigCalls).toEqual([null, null]);
        expect(requests).toEqual([]);
      }).pipe(
        provideReleaseHarness({ store, applyConfigCalls, requests }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_CONNECT_MODE: mode,
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
  it.effect("still stops locally if persisting desired-off fails", () => {
    const { store, values } = makeMemorySecretStore([[CLOUD_CLI_DESIRED_LINK_SECRET, "managed"]]);
    const guarded = ServerSecretStore.ServerSecretStore.of({
      ...store,
      remove: (name) =>
        name === CLOUD_CLI_DESIRED_LINK_SECRET
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: name,
                cause: "fixture-denied",
              }),
            )
          : store.remove(name),
    });
    const applyConfigCalls: Array<unknown> = [];
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect((yield* Effect.flip(link.unlink()))._tag).toBe("CloudLinkInternalError");
      expect(applyConfigCalls).toEqual([null]);
      expect(values.has(CLOUD_CLI_DESIRED_LINK_SECRET)).toBe(true);
    }).pipe(provideReleaseHarness({ store: guarded, applyConfigCalls, requests: [] }));
  });
  it.effect("does not downgrade a foreign binding if local key removal fails", () => {
    const { store, values } = makeMemorySecretStore([
      [RELAY_URL_SECRET, "https://selected.example.test"],
      [CLOUD_MINT_PUBLIC_KEY, "old-mint-key"],
      [
        CLOUD_PUBLIC_AUTHORITY_SECRET,
        JSON.stringify({
          version: 1,
          relayOrigin: "https://selected.example.test",
          cli: {
            version: 1,
            issuer: "https://clerk.example.test",
            tokenEndpointOrigin: "https://clerk.example.test",
            clientId: "foreign-client",
          },
        }),
      ],
    ]);
    const guarded = ServerSecretStore.ServerSecretStore.of({
      ...store,
      remove: (name) =>
        name === CLOUD_MINT_PUBLIC_KEY
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: name,
                cause: "fixture-denied",
              }),
            )
          : store.remove(name),
    });
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect((yield* Effect.flip(link.unlink()))._tag).toBe("CloudLinkInternalError");
      expect(applyConfigCalls).toEqual([null]);
      expect(values.has(CLOUD_PUBLIC_AUTHORITY_SECRET)).toBe(true);
      expect((yield* Effect.flip(link.answerHealthRequest({ proof: "old-proof" })))._tag).toBe(
        "CloudLinkAuthorityUnavailableError",
      );
      expect(requests).toEqual([]);
    }).pipe(
      provideReleaseHarness({ store: guarded, applyConfigCalls, requests }),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              T3CODE_CONNECT_MODE: "legacy",
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
  });
  // The relay commits before local storage. A partial write must not leave stale managed-tunnel state
  // that prevents Settings from relinking.
  it.effect("does not report a managed tunnel after a relay config write fails part-way", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "managed-config"],
      [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
    ]);
    const failingStore: ServerSecretStore.ServerSecretStore["Service"] = {
      ...store,
      set: (name, value) =>
        name === RELAY_ISSUER_SECRET
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${name}.bin`,
                }),
              }),
            )
          : store.set(name, value),
    };
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const cloudMintPublicKey =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMY09Vo5CzEA6aEkhB/0h27t4Qs71SHS1fTSI4K0KvZQ=\n-----END PUBLIC KEY-----\n";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(
        link.applyRelayConfig({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user-123",
          environmentCredential: "new-credential",
          cloudMintPublicKey,
          endpointRuntime: null,
        }),
      );

      expect(error._tag).toBe("CloudLinkInternalError");
      expect(yield* link.linkState()).toMatchObject({
        linked: true,
        cloudUserId: "user-123",
        managedTunnelActive: false,
      });
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store: failingStore, applyConfigCalls, requests }));
  });
});
