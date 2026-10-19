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
import * as Option from "effect/Option";
import * as NodeURL from "node:url";
import type { SqlError } from "effect/sql/SqlError";

import * as RelayDb from "../db.ts";

const fixtureFile = process.env.RELAY_PWA_TEST_FIXTURE_FILE;
const nativeFixtureFile = process.env.RELAY_ACCOUNT_DELETION_TEST_FIXTURE_FILE;
export const migrationDirectory = NodeURL.fileURLToPath(
  new URL("../../migrations/postgres", import.meta.url),
);
export const deletionMigration = "20261014174933_account_deletions";
export type FixtureSchema = "task4c_account_deletions" | "task4c_account_deletion_migration";
class FixtureConfigurationRejected extends Data.TaggedError("FixtureConfigurationRejected") {}
class FixtureMigrationError extends Data.TaggedError("FixtureMigrationError")<{
  readonly reason: string;
  readonly sqlState: string | null;
}> {
  override get message() {
    return `${this.reason}:${this.sqlState ?? "unknown"}`;
  }
}
// Keep fixture diagnostics bounded too; never include connection errors,
// SQL parameters, receipt contents or driver payloads in test output.
const migrationFailure = (cause: unknown) => {
  const queue: unknown[] = [cause];
  let reason = "migration_failed",
    sqlState: string | null = null;
  for (let i = 0; i < queue.length && i < 20; i++) {
    const value = queue[i];
    if (typeof value !== "object" || value === null) continue;
    if ("code" in value && typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code))
      sqlState = value.code;
    if ("message" in value && typeof value.message === "string") {
      for (const hint of [
        "syntax error",
        "permission denied",
        "already exists",
        "does not exist",
        "invalid regular expression",
        "violates",
        "migrations",
      ]) {
        if (value.message.includes(hint)) reason = hint.replaceAll(" ", "_");
      }
    }
    for (const key of ["cause", "reason", "error", "defect"] as const)
      if (key in value) queue.push(Reflect.get(value, key));
    if ("reasons" in value && Array.isArray(value.reasons)) queue.push(...value.reasons);
  }
  return new FixtureMigrationError({ reason, sqlState });
};
const identity = {
  host: Schema.Literal("192.168.80.2"),
  port: Schema.Literal(5432),
  containerId: Schema.Literal("dbc30b134c2b29164e8b69094e4038f3541b24158ac5a60cccbba50f1ef35390"),
  networkId: Schema.Literal("873a155e6310965ce514f0ff2cf5b47c4caf384e497b65a9d0eb8424c38dbdd7"),
  image: Schema.Literal(
    "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
  ),
};
const Connection = Schema.Struct({
  ...identity,
  fixtureOnly: Schema.Literal(true),
  internalDockerOnly: Schema.Literal(true),
  database: Schema.Literal("arcwright_connect_quota_fixture"),
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
  ssl: Schema.Literal(false),
  prepare: Schema.Literal(false),
});
const Receipt = Schema.Struct({
  ...identity,
  fixtureOnly: Schema.Literal(true),
  internalDockerOnly: Schema.Literal(true),
  productionTarget: Schema.Literal(false),
  hostPublishedPorts: Schema.Literal(0),
});
const Allowance = Schema.Struct({
  ...identity,
  database: Schema.Literal("arcwright_connect_quota_fixture"),
  C3_SPEC_and_QUALITY_approved_and_released: Schema.Literal(true),
  source_base: Schema.Literal("e17ed13da1e6c1e57bf7395e2d32cdb79c456e28"),
  allowed_schemas: Schema.Tuple([
    Schema.Literal("task4c_account_deletions"),
    Schema.Literal("task4c_account_deletion_migration"),
  ]),
  routes_enabled: Schema.Literal(false),
  public_or_external_operations_authorized: Schema.Literal(false),
});
const decodeConnection = Schema.decodeEffect(Schema.fromJsonString(Connection));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(Receipt));
const decodeAllowance = Schema.decodeEffect(Schema.fromJsonString(Allowance));
const NativeConnection = Schema.Struct({
  kind: Schema.Literal("owned-native-postgres-v1"),
  fixtureOnly: Schema.Literal(true),
  productionTarget: Schema.Literal(false),
  rootDirectory: Schema.NonEmptyString,
  dataDirectory: Schema.NonEmptyString,
  host: Schema.NonEmptyString,
  port: Schema.Literal(5432),
  database: Schema.NonEmptyString,
  username: Schema.NonEmptyString,
  password: Schema.NonEmptyString,
  ownerUid: Schema.Number,
  postmasterPid: Schema.Number,
});
const decodeNativeConnection = Schema.decodeEffect(Schema.fromJsonString(NativeConnection));
const verifiedNativeConnection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!nativeFixtureFile) return yield* new FixtureConfigurationRejected();
  const connection = yield* decodeNativeConnection(yield* fs.readFileString(nativeFixtureFile));
  const root = connection.rootDirectory;
  if (
    !/^\/tmp\/arcwright-relay-pg-[A-Za-z0-9_-]+$/.test(root) ||
    nativeFixtureFile !== `${root}/connection.json` ||
    connection.dataDirectory !== `${root}/data` ||
    connection.host !== `${root}/socket` ||
    !/^arcwright_test_[0-9a-f]{24}$/.test(connection.database) ||
    connection.username !== connection.database ||
    connection.ownerUid !== process.getuid?.()
  )
    return yield* new FixtureConfigurationRejected();
  for (const directory of [root, connection.dataDirectory, connection.host]) {
    const stat = yield* fs.stat(directory);
    if (
      stat.type !== "Directory" ||
      (stat.mode & 0o777) !== 0o700 ||
      Option.getOrUndefined(stat.uid) !== connection.ownerUid ||
      (yield* fs.realPath(directory)) !== directory
    )
      return yield* new FixtureConfigurationRejected();
  }
  const receipt = yield* fs.stat(nativeFixtureFile);
  const socket = yield* fs.stat(`${connection.host}/.s.PGSQL.5432`);
  const pid = (yield* fs.readFileString(`${connection.dataDirectory}/postmaster.pid`)).split("\n");
  if (
    receipt.type !== "File" ||
    (receipt.mode & 0o777) !== 0o600 ||
    Option.getOrUndefined(receipt.uid) !== connection.ownerUid ||
    (yield* fs.realPath(nativeFixtureFile)) !== nativeFixtureFile ||
    socket.type !== "Socket" ||
    (socket.mode & 0o777) !== 0o700 ||
    Option.getOrUndefined(socket.uid) !== connection.ownerUid ||
    !Number.isInteger(connection.postmasterPid) ||
    connection.postmasterPid <= 1 ||
    pid[0] !== String(connection.postmasterPid) ||
    pid[1] !== connection.dataDirectory ||
    pid[3] !== "5432" ||
    pid[4] !== connection.host ||
    pid[5] !== ""
  )
    return yield* new FixtureConfigurationRejected();
  return connection;
});
const verifiedConnection = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (nativeFixtureFile) return yield* verifiedNativeConnection;
  if (!fixtureFile) return yield* new FixtureConfigurationRejected();
  const directory = fixtureFile.slice(0, fixtureFile.lastIndexOf("/"));
  const connection = yield* decodeConnection(yield* fs.readFileString(fixtureFile));
  yield* decodeReceipt(yield* fs.readFileString(`${directory}/owned-resources.json`));
  const allowance = yield* decodeAllowance(
    yield* fs.readFileString(
      `${directory}/../task4c-account-deletion-design/parent-d1-fixture-allowance.json`,
    ),
  );
  if (allowance.database !== connection.database) return yield* new FixtureConfigurationRejected();
  return connection;
}).pipe(Effect.catchCause(() => Effect.fail(new FixtureConfigurationRejected())));

// The installed migrator's removed effect/unstable/sql/SqlError import leaves
// its error channel untyped. Restate the declared union at this test boundary;
// no runtime behavior, pool or compiler policy changes.
const checkedMigrate: (
  db: RelayDb.RelayDb["Service"],
  config: MigrationConfig,
) => Effect.Effect<undefined, EffectDrizzleQueryError | SqlError | MigratorInitError> = migrate;
export const runFixtureMigrations = (
  db: RelayDb.RelayDb["Service"],
  schema: FixtureSchema,
  folder = migrationDirectory,
) =>
  checkedMigrate(db, {
    migrationsFolder: folder,
    migrationsTable: "relay_migrations",
    migrationsSchema: schema,
  }).pipe(Effect.catchCause((cause) => Effect.fail(migrationFailure(cause))));

/** Each invocation owns a scoped pool. It never resets a schema. */
export const connectionLayer = (
  schema: FixtureSchema = "task4c_account_deletions",
  lockTimeout?: string,
) =>
  Layer.unwrap(
    verifiedConnection.pipe(
      Effect.map((connection) => {
        const pool = PgClient.layer({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          password: Redacted.make(connection.password),
          ssl: false,
          prepare: false,
          maxConnections: lockTimeout ? 1 : 8,
          startupParameters: {
            search_path: schema,
            application_name: "task4c-account-deletion-d1",
            ...(lockTimeout ? { lock_timeout: lockTimeout } : {}),
          },
        });
        // Verify the server behind the owned socket before exposing a client
        // capable of resetting either test schema.
        if (!("dataDirectory" in connection)) return pool;
        return Layer.effect(
          PgClient.PgClient,
          Effect.gen(function* () {
            const client = yield* PgClient.PgClient;
            const [identity] = yield* client<{
              database: string;
              dataDirectory: string;
            }>`SELECT current_database() AS database, current_setting('data_directory') AS "dataDirectory"`;
            if (
              identity?.database !== connection.database ||
              identity.dataDirectory !== connection.dataDirectory
            )
              return yield* new FixtureConfigurationRejected();
            return client;
          }),
        ).pipe(Layer.provide(pool));
      }),
    ),
  ).pipe(Layer.provide(NodeFileSystem.layer));
export const connectDatabase = (lockTimeout?: string) =>
  Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(connectionLayer("task4c_account_deletions", lockTimeout)),
  );

/** Only these two literally authorized D1 schemas can be reset. */
export const layerDb = Layer.effect(
  RelayDb.RelayDb,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults();
    yield* db.$client`DROP SCHEMA IF EXISTS task4c_account_deletions CASCADE`;
    yield* db.$client`CREATE SCHEMA task4c_account_deletions`;
    yield* runFixtureMigrations(db, "task4c_account_deletions");
    return db;
  }),
).pipe(Layer.provide(connectionLayer()));
export const layerLegacyDb = Layer.effect(
  RelayDb.RelayDb,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const db = yield* PgDrizzle.makeWithDefaults();
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "account-deletion-upgrade-" });
    for (const directory of (yield* fs.readDirectory(migrationDirectory))
      .filter((name) => name < deletionMigration)
      .sort()) {
      yield* fs.copy(`${migrationDirectory}/${directory}`, `${folder}/${directory}`);
    }
    yield* db.$client`DROP SCHEMA IF EXISTS task4c_account_deletion_migration CASCADE`;
    yield* db.$client`CREATE SCHEMA task4c_account_deletion_migration`;
    yield* runFixtureMigrations(db, "task4c_account_deletion_migration", folder);
    return db;
  }),
).pipe(
  Layer.provide(connectionLayer("task4c_account_deletion_migration")),
  Layer.provide(NodeFileSystem.layer),
);
