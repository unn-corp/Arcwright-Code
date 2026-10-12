// @effect-diagnostics nodeBuiltinImport:off
import { assert, it, vi } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import { runMigrations, migrationManifest, migrationEntries } from "./Migrations.ts";
import {
  hasCurrentSchemaFingerprint,
  canonicalSchemaDefinition,
  readSchemaObjects,
  schemaDigest,
  expectedSchemaObjects,
} from "./SchemaFingerprint.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });
it.effect("keeps the compiled schema contract synchronized with the actual migration source", () =>
  Effect.gen(function* () {
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
        ),
      ),
    });
    assert.equal(schemaDigest(yield* readSchemaObjects), schemaDigest(expectedSchemaObjects));
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "launches a migrated database through metadata reads without executing migration writes again",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const fingerprint = yield* sql`SELECT * FROM arcwright_schema_fingerprint`;
      yield* sql`UPDATE arcwright_storage_migrations SET state='pending' WHERE version=1`;
      const statements: string[] = [];
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const spy = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, statement: string) {
          statements.push(statement);
          return prepare.call(this, statement);
        });
      try {
        assert.deepEqual(yield* runMigrations(), []);
      } finally {
        spy.mockRestore();
      }
      assert.isTrue(statements.length > 0);
      assert.isFalse(
        statements.some((statement) =>
          /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|VACUUM|BEGIN)\b/i.test(statement),
        ),
      );
      assert.isFalse(
        statements.some((statement) =>
          /FROM\s+(?:orchestration_events|projection_thread|orchestration_v2_projection)/i.test(
            statement,
          ),
        ),
      );
      assert.deepEqual(yield* sql`SELECT * FROM arcwright_schema_fingerprint`, fingerprint);
      assert.deepEqual(yield* sql`SELECT state FROM arcwright_storage_migrations`, [
        { state: "pending" },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects an altered required schema even when the migration IDs are current", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP INDEX orchestration_v2_projection_provider_threads_recovery_idx`;
    assert.isFalse(yield* hasCurrentSchemaFingerprint(migrationManifest));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "detects ledger tampering and a new migration manifest without trusting the old SHA",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      assert.isTrue(yield* hasCurrentSchemaFingerprint(migrationManifest));
      assert.isFalse(
        yield* hasCurrentSchemaFingerprint([...migrationManifest, [107, "FutureUpgrade"]]),
      );
      yield* sql`UPDATE effect_sql_migrations SET name='other-build' WHERE migration_id=103`;
      assert.isFalse(yield* hasCurrentSchemaFingerprint(migrationManifest));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves the fingerprint when maintenance removes only the three intentionally retired indexes",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP INDEX idx_orch_events_correlation_id`;
      yield* sql`DROP INDEX idx_orch_command_receipts_aggregate`;
      yield* sql`DROP INDEX idx_orch_command_receipts_sequence`;
      assert.isTrue(yield* hasCurrentSchemaFingerprint(migrationManifest));
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(layer)),
);

it("accepts older column ordering and SQL formatting while retaining defaults and constraints", () => {
  const object = { type: "table", name: "t", tbl_name: "t" };
  const expected = canonicalSchemaDefinition({
    ...object,
    sql: "CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT 'Keep, (this)')",
  });
  assert.equal(
    canonicalSchemaDefinition({
      ...object,
      sql: "create table \"t\" (body text not null default 'Keep, (this)', id text primary key)",
    }),
    expected,
  );
  assert.notEqual(
    canonicalSchemaDefinition({
      ...object,
      sql: "CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT DEFAULT 'Keep, (this)')",
    }),
    expected,
  );
  assert.notEqual(
    canonicalSchemaDefinition({
      ...object,
      sql: "CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT 'keep, (this)')",
    }),
    expected,
  );
});
