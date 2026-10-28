import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import type { EffectDrizzleQueryError, MigratorInitError } from "drizzle-orm/effect-core/errors";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import type { MigrationConfig } from "drizzle-orm/migrator";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";

// Only this explicitly owned disposable fixture is admissible. No ambient DB
// variable is consulted, and both schemas below belong exclusively to this suite.
export const fixtureFile = process.env.RELAY_PWA_TEST_FIXTURE_FILE;
export const migrationDirectory = "infra/relay/migrations/postgres";
export const incarnationMigration = "20261013030258_delivery_incarnations";
const containerId = "dbc30b134c2b29164e8b69094e4038f3541b24158ac5a60cccbba50f1ef35390";
const networkId = "873a155e6310965ce514f0ff2cf5b47c4caf384e497b65a9d0eb8424c38dbdd7";
const image =
  "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
class FixtureConfigurationRejected extends Data.TaggedError("FixtureConfigurationRejected") {}
class FixtureMigrationError extends Data.TaggedError("FixtureMigrationError")<{
  readonly cause: unknown;
}> {}
const identity = {
  fixtureOnly: Schema.Literal(true),
  internalDockerOnly: Schema.Literal(true),
  host: Schema.Literal("192.168.80.2"),
  port: Schema.Literal(5432),
  containerId: Schema.Literal(containerId),
  networkId: Schema.Literal(networkId),
  image: Schema.Literal(image),
};
const Connection = Schema.Struct({
  ...identity,
  database: Schema.Literal("arcwright_connect_quota_fixture"),
  username: Schema.String,
  password: Schema.String,
  ssl: Schema.Literal(false),
  prepare: Schema.Literal(false),
});
const Receipt = Schema.Struct({
  ...identity,
  productionTarget: Schema.Literal(false),
  hostPublishedPorts: Schema.Literal(0),
});
const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(Connection));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));

export const migrationConfig = {
  migrationsFolder: migrationDirectory,
  migrationsTable: "relay_migrations",
  migrationsSchema: "task4c_incarnations",
};

// The migrator references the removed effect/unstable/sql/SqlError module.
// Restate its error union using the current client type at this test boundary.
const checkedMigrate: (
  db: RelayDb.RelayDb["Service"],
  config: MigrationConfig,
) => Effect.Effect<undefined, EffectDrizzleQueryError | SqlError | MigratorInitError> = migrate;

export const runFixtureMigrations = (db: RelayDb.RelayDb["Service"], config: MigrationConfig) => {
  const migration = checkedMigrate(db, config);
  return migration.pipe(Effect.mapError((cause) => new FixtureMigrationError({ cause })));
};

const databaseLayer = (legacy: boolean) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!fixtureFile) return yield* new FixtureConfigurationRejected();
      const connection = yield* decodeConnection(yield* fs.readFileString(fixtureFile)).pipe(
        Effect.mapError(() => new FixtureConfigurationRejected()),
      );
      yield* decodeReceipt(
        yield* fs.readFileString(
          `${fixtureFile.slice(0, fixtureFile.lastIndexOf("/"))}/owned-resources.json`,
        ),
      ).pipe(Effect.mapError(() => new FixtureConfigurationRejected()));
      const schema = legacy ? "task4c_incarnation_migration" : "task4c_incarnations";
      return Layer.effect(
        RelayDb.RelayDb,
        Effect.gen(function* () {
          const db = yield* PgDrizzle.makeWithDefaults();
          yield* db.$client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          yield* db.$client.unsafe(`CREATE SCHEMA ${schema}`);
          let migrationsFolder = migrationDirectory;
          if (legacy) {
            const oldMigrations = yield* fs.makeTempDirectoryScoped({
              prefix: "incarnation-migrations-",
            });
            for (const name of yield* fs.readDirectory(migrationDirectory)) {
              if (name < incarnationMigration) {
                yield* fs.copy(`${migrationDirectory}/${name}`, `${oldMigrations}/${name}`);
              }
            }
            migrationsFolder = oldMigrations;
          }
          yield* runFixtureMigrations(db, {
            ...migrationConfig,
            migrationsFolder,
            migrationsSchema: schema,
          });
          return db;
        }),
      ).pipe(
        Layer.provide(
          PgClient.layer({
            host: connection.host,
            port: connection.port,
            database: connection.database,
            username: connection.username,
            password: Redacted.make(connection.password),
            ssl: false,
            prepare: false,
            startupParameters: { search_path: `${schema},public` },
            maxConnections: 16,
          }),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

export const layerDb = databaseLayer(false);
export const layerLegacyDb = databaseLayer(true);
export const layerPersistence = Layer.merge(
  EnvironmentLinks.layer,
  WebPushSubscriptions.layer.pipe(Layer.provide(NodeCrypto.layer)),
).pipe(Layer.provideMerge(layerDb));
