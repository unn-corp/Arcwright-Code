import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  relayDatabaseProviderConfig,
  relayHyperdriveIdConfig,
  relayRuntimeTokenModeConfig,
  relayTracingEnabledConfig,
  relayZoneOwnerStageConfig,
} from "./deploymentOptions.ts";
import { externalHyperdriveConnectionString } from "./db.ts";

const options = Config.all({
  database: relayDatabaseProviderConfig,
  tracing: relayTracingEnabledConfig,
  zoneOwner: relayZoneOwnerStageConfig,
  runtimeTokens: relayRuntimeTokenModeConfig,
});

it.effect("preserves upstream deployment defaults", () =>
  Effect.gen(function* () {
    expect(yield* options).toEqual({
      database: "planetscale",
      tracing: true,
      zoneOwner: "prod",
      runtimeTokens: "managed",
    });
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))),
);

it.effect("selects the existing infrastructure without PlanetScale or tracing", () =>
  Effect.gen(function* () {
    expect(yield* options).toEqual({
      database: "existing-hyperdrive",
      tracing: false,
      zoneOwner: "devotek-pilot",
      runtimeTokens: "existing",
    });
    expect(yield* relayHyperdriveIdConfig).toBe("0123456789abcdef0123456789abcdef");
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        RELAY_DATABASE_PROVIDER: "existing-hyperdrive",
        RELAY_HYPERDRIVE_ID: "0123456789abcdef0123456789abcdef",
        RELAY_TRACING_ENABLED: "false",
        RELAY_ZONE_OWNER_STAGE: "devotek-pilot",
        RELAY_RUNTIME_TOKEN_MODE: "existing",
      }),
    ),
  ),
);

it.effect.each([{}, { RELAY_HYPERDRIVE_ID: "" }, { RELAY_HYPERDRIVE_ID: "not-a-hyperdrive-id" }])(
  "rejects a missing or invalid required external Hyperdrive ID %j",
  (env) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(relayHyperdriveIdConfig))._tag).toBe("ConfigError");
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))),
);

it.effect.each([
  { RELAY_DATABASE_PROVIDER: "postgres" },
  { RELAY_TRACING_ENABLED: "invalid" },
  { RELAY_RUNTIME_TOKEN_MODE: "invalid" },
])("rejects malformed operator options %j", (env) =>
  Effect.gen(function* () {
    expect((yield* Effect.flip(options))._tag).toBe("ConfigError");
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))),
);

it.effect("reads the runtime binding as a redacted connection string", () =>
  Effect.gen(function* () {
    const value = yield* externalHyperdriveConnectionString;
    expect(Redacted.value(value)).toBe("postgres://runtime:synthetic@hyperdrive.test/relay");
    expect(String(value)).not.toContain("synthetic");
  }).pipe(
    Effect.provideService(Cloudflare.WorkerEnvironment, {
      RELAY_EXTERNAL_HYPERDRIVE: {
        connectionString: "postgres://runtime:synthetic@hyperdrive.test/relay",
      },
    }),
  ),
);

it.effect.each([undefined, null, {}, { connectionString: "" }, { connectionString: 123 }])(
  "rejects an unavailable runtime database binding %j",
  (binding) =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(externalHyperdriveConnectionString))._tag).toBe(
        "RelayHyperdriveBindingMissing",
      );
    }).pipe(
      Effect.provideService(Cloudflare.WorkerEnvironment, {
        RELAY_EXTERNAL_HYPERDRIVE: binding,
      }),
    ),
);
