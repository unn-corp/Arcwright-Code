import * as NodeBuffer from "node:buffer";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class FixtureConfigurationRejected extends Data.TaggedError("FixtureConfigurationRejected") {}

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
export const verifiedNativeConnection = Effect.fn("ownedNativePostgres.verifiedNativeConnection")(
  function* (nativeFixtureFile: string | undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!nativeFixtureFile) return yield* new FixtureConfigurationRejected();
    const temporaryDirectory = process.env.TMPDIR ?? "/tmp";
    if (!path.isAbsolute(temporaryDirectory)) return yield* new FixtureConfigurationRejected();
    const temporaryParent = yield* fs.realPath(temporaryDirectory);
    if ((yield* fs.stat(temporaryParent)).type !== "Directory")
      return yield* new FixtureConfigurationRejected();
    const connection = yield* decodeNativeConnection(yield* fs.readFileString(nativeFixtureFile));
    const root = connection.rootDirectory;
    const rootName = path.basename(root);
    if (
      (yield* HostProcess.Platform) === "linux" &&
      NodeBuffer.Buffer.byteLength(`${connection.host}/.s.PGSQL.5432`) > 107
    )
      return yield* new FixtureConfigurationRejected();
    if (
      path.dirname(root) !== temporaryParent ||
      rootName.match(/^arcwright-relay-pg-[A-Za-z0-9_-]+/)?.[0] !== rootName ||
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
    const pid = (yield* fs.readFileString(`${connection.dataDirectory}/postmaster.pid`)).split(
      "\n",
    );
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
  },
  Effect.provide(Path.layer),
);
export const verifiedNativeClient = Effect.fn("ownedNativePostgres.verifiedNativeClient")(
  function* (connection: Pick<typeof NativeConnection.Type, "database" | "dataDirectory">) {
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
  },
);
