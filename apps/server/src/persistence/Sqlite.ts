import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import { acquireMaintenanceHost } from "../maintenance/MaintenanceHost.ts";
import { runStorageWorker } from "../maintenance/storageWorker.ts";

export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // Only an empty file can switch modes here; an existing database needs the
    // offline VACUUM that `t3 doctor` runs, which rebuilds it with pointer maps.
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // FULL fsyncs the WAL on every commit, on the main thread. Every provider
    // event is its own commit, so a slow or busy disk stalls the event loop
    // and clients drop. In WAL mode NORMAL only fsyncs at checkpoints. It
    // cannot corrupt the database and an app crash loses nothing; an OS crash
    // or power loss can roll back commits since the last checkpoint.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // Checkpoints are now the only sync, and macOS fsync() does not flush the
    // drive cache. F_FULLFSYNC makes them reach disk; other platforms ignore it.
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    yield* sql`PRAGMA optimize = 0x10012;`;
  }),
);

export const layerFromPath = Effect.fn("Sqlite.layerFromPath")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      readerWorker: true,
      // Checkpoints sync the database, with F_FULLFSYNC on macOS. Run them off
      // the event loop so a slow flush cannot stall clients.
      checkpointWorker: true,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const { dbPath } = config;
    // The start gate runs before the database is created, opened or migrated: a runtime
    // started during a device transaction must not touch a home that is being snapshotted.
    const host = yield* acquireMaintenanceHost(config).pipe(Effect.orDie);
    yield* initializeV2Database(dbPath);
    if (host.mode === "active" && host.trial !== null) {
      const journal = yield* Effect.promise(() =>
        host.store.readJournal(host.trial!.transactionId),
      );
      if (journal?.storageOptimization === true) {
        // Close the migration connection before the one-shot optimizer opens the database.
        yield* Effect.scoped(Layer.build(layerFromPath(dbPath)));
        yield* Effect.promise(() => runStorageWorker(host, journal.id));
      }
    }
    return layerFromPath(dbPath);
  }),
);
