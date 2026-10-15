import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

/** Upstream defaults remain available; an external database must be selected explicitly. */
export const relayDatabaseProviderConfig = Config.schema(
  Schema.Literals(["planetscale", "existing-hyperdrive"]),
  "RELAY_DATABASE_PROVIDER",
).pipe(Config.withDefault("planetscale"));

export const relayHyperdriveIdConfig = Config.schema(
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  "RELAY_HYPERDRIVE_ID",
);

export const relayTracingEnabledConfig = Config.Boolean("RELAY_TRACING_ENABLED").pipe(
  Config.withDefault(true),
);

export const relayZoneOwnerStageConfig = Config.NonEmptyString("RELAY_ZONE_OWNER_STAGE").pipe(
  Config.withDefault("prod"),
);

export const relayRuntimeTokenModeConfig = Config.schema(
  Schema.Literals(["managed", "existing"]),
  "RELAY_RUNTIME_TOKEN_MODE",
).pipe(Config.withDefault("managed"));
