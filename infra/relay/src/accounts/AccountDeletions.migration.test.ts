import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { generateDrizzleJson } from "drizzle-kit/api-postgres";
import * as RelayDb from "../db.ts";
import * as databaseSchema from "../persistence/schema.ts";
import {
  deletionMigration,
  layerDb,
  layerLegacyDb,
  migrationDirectory,
  runFixtureMigrations,
} from "./accountDeletionPostgresFixture.ts";
import {
  configuration,
  fixture,
  oldRowClasses,
  seedOldRow,
  setup,
} from "./accountDeletionTestFixture.ts";

const decodeSnapshot = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      prevIds: Schema.Array(Schema.String),
      version: Schema.String,
      dialect: Schema.String,
      ddl: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

describe("Account deletion isolated actual PostgreSQL DDL", () => {
  it.effect("has all four durable account tables", () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const tables = yield* db.$client<{
        table_name: string;
      }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'task4c_account_deletions' AND table_name LIKE 'relay_account_%' ORDER BY table_name`;
      expect(tables.map((row) => row.table_name)).toEqual([
        "relay_account_authorities",
        "relay_account_deletion_endpoints",
        "relay_account_deletion_events",
        "relay_account_deletions",
      ]);
    }).pipe(Effect.provide(Layer.fresh(layerDb))),
  );

  it.effect(
    "genuine upgrade preserves all seven old owned row classes, lifecycle defaults and old schema DDL without any attribution",
    () =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const before: ReadonlyArray<unknown>[] = [];
        const tables = [
          "relay_environment_links",
          "relay_managed_endpoint_allocations",
          "relay_managed_tunnel_limits",
          "relay_mobile_devices",
          "relay_live_activities",
          "relay_web_push_subscriptions",
          "relay_delivery_attempts",
        ];
        for (const [i, kind] of oldRowClasses.entries())
          yield* seedOldRow(db, kind, `user_Upgrade${i}`);
        for (const table of tables)
          before.push(yield* db.$client`SELECT to_jsonb(t) AS row FROM ${db.$client(table)} t`);
        const oldColumns =
          yield* db.$client`SELECT table_name, column_name, column_default, is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'task4c_account_deletion_migration' ORDER BY table_name, ordinal_position`;
        yield* runFixtureMigrations(db, "task4c_account_deletion_migration");
        for (const [i, table] of tables.entries())
          expect(yield* db.$client`SELECT to_jsonb(t) AS row FROM ${db.$client(table)} t`).toEqual(
            before[i],
          );
        expect(
          yield* db.$client`SELECT table_name, column_name, column_default, is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'task4c_account_deletion_migration' AND table_name NOT LIKE 'relay_account_%' ORDER BY table_name, ordinal_position`,
        ).toEqual(oldColumns);
        expect(yield* db.$client`SELECT user_id FROM relay_account_authorities`).toEqual([]);
        expect(yield* db.$client`SELECT intent_id FROM relay_account_deletions`).toEqual([]);
        expect(
          yield* db.$client`SELECT lifecycle_state FROM relay_managed_endpoint_allocations`,
        ).toEqual([{ lifecycle_state: "legacy_unverified" }]);
        yield* seedOldRow(db, "allocations", "user_PostMigration");
        expect(
          yield* db.$client`SELECT lifecycle_state FROM relay_managed_endpoint_allocations ORDER BY user_id`,
        ).toEqual([
          { lifecycle_state: "legacy_unverified" },
          { lifecycle_state: "legacy_unverified" },
        ]);
      }).pipe(Effect.provide(Layer.fresh(layerLegacyDb))),
  );

  it.effect(
    "actual constraints reject invalid authorities, unbounded identifiers and nonfinite times",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db } = yield* setup;
          const invalid = [
            { userId: "user_", issuer: configuration.issuer, instance: configuration.instanceId },
            {
              userId: "user_a_b",
              issuer: configuration.issuer,
              instance: configuration.instanceId,
            },
            {
              userId: `user_${"a".repeat(187)}`,
              issuer: configuration.issuer,
              instance: configuration.instanceId,
            },
            ...[
              "http://fixture.test",
              "https://UPPER.fixture.test",
              "https://fixture.test/",
              "https://fixture.test?x",
              "https://user:secret@fixture.test",
              "https://fixture.test:443",
              "https://fixture.test:65536",
              "x".repeat(2049),
            ].map((issuer) => ({
              userId: "user_Invalid",
              issuer,
              instance: configuration.instanceId,
            })),
            ...["", "a".repeat(192), "bad instance", "bad\ninstance"].map((instance) => ({
              userId: "user_Invalid",
              issuer: configuration.issuer,
              instance,
            })),
          ];
          for (const value of invalid)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client`INSERT INTO relay_account_authorities(user_id, issuer, instance_id) VALUES (${value.userId}, ${value.issuer}, ${value.instance})`,
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_authorities(user_id, issuer, instance_id, bound_at) VALUES ('user_Infinite', ${configuration.issuer}, ${configuration.instanceId}, 'infinity'::timestamptz)`,
              ),
            ),
          ).toBe(true);
          yield* db.$client`INSERT INTO relay_account_authorities(user_id, issuer, instance_id) VALUES (${`user_${"a".repeat(186)}`}, 'https://[::1]:8443', ${"a".repeat(191)})`;
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_authorities(user_id, issuer, instance_id) VALUES (${`user_${"a".repeat(186)}`}, 'https://other.fixture.test', 'ins_other')`,
              ),
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "intent PK/UUID/state/completion/time checks and permanent monotonic deny hold in actual SQL",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedSession("user_Constraints");
          const accepted = yield* deletions.acceptManual(subject);
          for (const update of [
            "status = 'invented'",
            "reason = 'raw_sdk_error'",
            "attempt_count = -1",
            "status = 'complete'",
            "completed_at = CURRENT_TIMESTAMP",
            "requested_at = 'infinity'::timestamptz",
            "next_attempt_at = '-infinity'::timestamptz",
            "identity_deleted_at = 'infinity'::timestamptz",
            "issuer = 'https://other.fixture.test'",
            "instance_id = 'ins_other'",
            "user_id = 'user_Other'",
            "intent_id = gen_random_uuid()",
            "requested_at = '2000-01-01Z'::timestamptz",
            "source_manual = false",
          ])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_account_deletions SET ${update}`),
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletions(issuer, instance_id, user_id, intent_id) VALUES (${subject.issuer}, ${subject.instanceId}, 'user_Other', ${accepted.intentId}::uuid)`,
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletions(issuer, instance_id, user_id) VALUES (${subject.issuer}, ${subject.instanceId}, ${subject.userId})`,
              ),
            ),
          ).toBe(true);
          yield* db.$client`UPDATE relay_account_deletions SET identity_deleted_at = CURRENT_TIMESTAMP, revoked_at = CURRENT_TIMESTAMP, local_purged_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, status = 'complete', attempt_count = 5`;
          const complete = yield* db.$client`SELECT * FROM relay_account_deletions`;
          for (const update of [
            "status = 'pending', completed_at = NULL",
            "identity_deleted_at = NULL",
            "revoked_at = NULL",
            "local_purged_at = NULL",
            "completed_at = NULL",
            "identity_deleted_at = '2000-01-01Z'::timestamptz",
            "attempt_count = 4",
          ])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_account_deletions SET ${update}`),
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(yield* Effect.result(db.$client`DELETE FROM relay_account_deletions`)),
          ).toBe(true);
          expect(yield* db.$client`SELECT * FROM relay_account_deletions`).toEqual(complete);
          for (const update of [
            "issuer = 'https://other.fixture.test'",
            "instance_id = 'ins_other'",
            "user_id = 'user_Other'",
            "bound_at = '2000-01-01Z'::timestamptz",
          ])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_account_authorities SET ${update}`),
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(db.$client`DELETE FROM relay_account_authorities`),
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "receipt PK/FK/bounds/finite event time and immutable exact delivery identity hold in actual SQL",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const subject = yield* port.fromAlreadyVerifiedDeletion("user_Receipt");
          const accepted = yield* deletions.acceptClerkDeletion({
            verifiedSubject: subject,
            svixId: "msg_original",
            eventTimestamp: 1,
          });
          for (const id of ["", "x".repeat(256), "bad id", "bad\nid", "bad/id"])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client`INSERT INTO relay_account_deletion_events(instance_id, svix_id, intent_id, event_timestamp) VALUES (${subject.instanceId}, ${id}, ${accepted.intentId}::uuid, 1)`,
                ),
              ),
            ).toBe(true);
          for (const event of ["NaN", "Infinity", "-Infinity"])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client`INSERT INTO relay_account_deletion_events(instance_id, svix_id, intent_id, event_timestamp) VALUES (${subject.instanceId}, 'msg_bad_time', ${accepted.intentId}::uuid, ${event}::double precision)`,
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletion_events(instance_id, svix_id, intent_id, event_timestamp) VALUES (${subject.instanceId}, 'msg_no_intent', gen_random_uuid(), 1)`,
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletion_events(instance_id, svix_id, intent_id, event_timestamp, received_at) VALUES (${subject.instanceId}, 'msg_bad_time', ${accepted.intentId}::uuid, 1, 'infinity'::timestamptz)`,
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletion_events(instance_id, svix_id, intent_id, event_timestamp) VALUES (${subject.instanceId}, 'msg_original', ${accepted.intentId}::uuid, 2)`,
              ),
            ),
          ).toBe(true);
          const receipt = yield* db.$client`SELECT * FROM relay_account_deletion_events`;
          for (const update of [
            "instance_id = 'ins_other'",
            "svix_id = 'msg_retarget'",
            "intent_id = gen_random_uuid()",
            "received_at = '2000-01-01Z'::timestamptz",
            "event_timestamp = 2",
          ])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_account_deletion_events SET ${update}`),
                ),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(db.$client`DELETE FROM relay_account_deletion_events`),
            ),
          ).toBe(true);
          expect(yield* db.$client`SELECT * FROM relay_account_deletion_events`).toEqual(receipt);
        }),
      ),
  );

  it.effect(
    "endpoint receipts keep exact immutable allocation/resource identity with bounded IDs/generation and mutable progress",
    () =>
      fixture(
        Effect.gen(function* () {
          const { db, port, deletions } = yield* setup;
          const accepted = yield* deletions.acceptManual(
            yield* port.fromAlreadyVerifiedSession("user_Endpoint"),
          );
          const allocation = "00000000-0000-4000-8000-000000000001";
          const insert = (
            generation: number,
            environment: string,
            tunnelName: string,
            endpointKey: string,
            namespace: string,
            tunnelId: string | null = null,
            dnsId: string | null = null,
          ) =>
            db.$client`INSERT INTO relay_account_deletion_endpoints(intent_id, allocation_id, environment_id, observed_generation, tunnel_name, endpoint_key, namespace, tunnel_id, dns_record_id) VALUES (${accepted.intentId}::uuid, ${allocation}::uuid, ${environment}, ${generation}, ${tunnelName}, ${endpointKey}, ${namespace}, ${tunnelId}, ${dnsId})`;
          // PostgreSQL may coerce a numeric parameter before integer CHECKs. D2's
          // actual capture must validate its observed int32 before binding it; D1 has
          // no receipt writer. Prove storage/range and text integer parsing here.
          for (const generation of [-1, Infinity, 2_147_483_648])
            expect(
              Result.isFailure(
                yield* Effect.result(insert(generation, "env", "tunnel", "endpoint", "namespace")),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletion_endpoints(intent_id, allocation_id, environment_id, observed_generation, tunnel_name, endpoint_key, namespace) VALUES (${accepted.intentId}::uuid, ${allocation}::uuid, 'env', ${"1.5"}::text::integer, 'tunnel', 'endpoint', 'namespace')`,
              ),
            ),
          ).toBe(true);
          for (const [generation, environment, tunnelName, endpointKey, namespace] of [
            [0, "", "tunnel", "endpoint", "namespace"],
            [0, "env", "", "endpoint", "namespace"],
            [0, "env", "tunnel", "", "namespace"],
            [0, "env", "tunnel", "endpoint", ""],
            [0, "x".repeat(192), "tunnel", "endpoint", "namespace"],
            [0, "env", "x".repeat(254), "endpoint", "namespace"],
            [0, "env", "tunnel", "x".repeat(254), "namespace"],
            [0, "env", "tunnel", "endpoint", "x".repeat(192)],
          ] as const)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  insert(generation, environment, tunnelName, endpointKey, namespace),
                ),
              ),
            ).toBe(true);
          for (const id of ["", "x".repeat(192), "bad\nid"])
            expect(
              Result.isFailure(
                yield* Effect.result(insert(0, "env", "tunnel", "endpoint", "namespace", id, null)),
              ),
            ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_account_deletion_endpoints(intent_id, allocation_id, environment_id, observed_generation, tunnel_name, endpoint_key, namespace) VALUES (gen_random_uuid(), gen_random_uuid(), 'env', 0, 'tunnel', 'key', 'namespace')`,
              ),
            ),
          ).toBe(true);
          yield* insert(0, "env", "tunnel", "endpoint", "namespace");
          expect(
            yield* db.$client`SELECT pg_typeof(observed_generation)::text AS generation_type, observed_generation FROM relay_account_deletion_endpoints`,
          ).toEqual([{ generation_type: "integer", observed_generation: 0 }]);
          yield* db.$client`INSERT INTO relay_account_deletion_endpoints(intent_id, allocation_id, environment_id, observed_generation, tunnel_name, endpoint_key, namespace, tunnel_id, dns_record_id) VALUES (${accepted.intentId}::uuid, gen_random_uuid(), ${"e".repeat(191)}, 2147483647, ${"t".repeat(253)}, ${"k".repeat(253)}, ${"n".repeat(191)}, ${"t".repeat(191)}, ${"d".repeat(191)})`;
          expect(
            Result.isFailure(
              yield* Effect.result(insert(0, "env", "tunnel", "endpoint", "namespace")),
            ),
          ).toBe(true);
          const before = yield* db.$client`SELECT * FROM relay_account_deletion_endpoints`;
          for (const update of [
            "intent_id = gen_random_uuid()",
            "allocation_id = gen_random_uuid()",
            "environment_id = 'replacement'",
            "observed_generation = 1",
            "tunnel_id = 'replacement'",
            "dns_record_id = 'replacement'",
            "tunnel_name = 'replacement'",
            "endpoint_key = 'replacement'",
            "namespace = 'replacement'",
            "reason = 'raw_sdk_error'",
            "hooks_disabled_at = 'infinity'::timestamptz",
          ])
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_account_deletion_endpoints SET ${update}`),
                ),
              ),
            ).toBe(true);
          expect(yield* db.$client`SELECT * FROM relay_account_deletion_endpoints`).toEqual(before);
          yield* db.$client`UPDATE relay_account_deletion_endpoints SET hooks_disabled_at = CURRENT_TIMESTAMP, allocation_removed_at = CURRENT_TIMESTAMP, reason = 'endpoint_busy'`;
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`UPDATE relay_account_deletion_endpoints SET hooks_disabled_at = NULL`,
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`UPDATE relay_account_deletion_endpoints SET allocation_removed_at = NULL`,
              ),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(db.$client`DELETE FROM relay_account_deletion_endpoints`),
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "snapshot matches generated schema, actual columns/defaults/constraints/FKs, and the four custom trigger guards",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const fs = yield* FileSystem.FileSystem;
          const snapshot = yield* decodeSnapshot(
            yield* fs.readFileString(`${migrationDirectory}/${deletionMigration}/snapshot.json`),
          );
          const prior = yield* decodeSnapshot(
            yield* fs.readFileString(
              `${migrationDirectory}/20261013154149_managed_endpoint_lifecycle/snapshot.json`,
            ),
          );
          expect(snapshot).toMatchObject({
            version: "8",
            dialect: "postgres",
            prevIds: [prior.id],
          });
          const regenerated = yield* Effect.promise(() =>
            generateDrizzleJson(databaseSchema, prior.id),
          );
          // Node's module namespace enumerates exports alphabetically; Vite retains
          // source insertion order. Compare every full descriptor, independent of
          // that import enumeration order (including all column/check/FK fields).
          expect(regenerated.ddl.map((entry) => JSON.stringify(entry)).sort()).toEqual(
            snapshot.ddl.map((entry) => JSON.stringify(entry)).sort(),
          );
          const oldDdl = snapshot.ddl.filter(
            (entry) =>
              !(typeof entry.table === "string" && entry.table.startsWith("relay_account_")) &&
              !(typeof entry.name === "string" && entry.name.startsWith("relay_account_")) &&
              entry.name !== "idx_account_authority_identity",
          );
          expect(oldDdl).toEqual(prior.ddl);
          const columns = yield* db.$client<{
            table_name: string;
            column_name: string;
            type: string;
            not_null: boolean;
            default_expression: string | null;
          }>`SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expression FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum WHERE n.nspname = 'task4c_account_deletions' AND c.relkind = 'r' AND c.relname LIKE 'relay_account_%' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`;
          const recordedColumns = snapshot.ddl.filter(
            (entry) =>
              entry.entityType === "columns" &&
              typeof entry.table === "string" &&
              entry.table.startsWith("relay_account_"),
          );
          expect(columns).toHaveLength(recordedColumns.length);
          for (const entry of recordedColumns) {
            const actual = columns.find(
              (column) => column.table_name === entry.table && column.column_name === entry.name,
            );
            expect(actual?.type.replace("character varying", "varchar")).toBe(entry.type);
            expect(actual?.not_null).toBe(entry.notNull);
            expect(actual?.default_expression?.replace("::character varying", "") ?? null).toBe(
              entry.default,
            );
          }
          const constraints = yield* db.$client<{
            table_name: string;
            name: string;
            type: string;
          }>`SELECT c.relname AS table_name, p.conname AS name, p.contype AS type FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'task4c_account_deletions' AND c.relname LIKE 'relay_account_%' ORDER BY c.relname, p.conname`;
          const recorded = snapshot.ddl.filter(
            (entry) =>
              ["checks", "pks", "uniques", "fks"].includes(String(entry.entityType)) &&
              typeof entry.table === "string" &&
              entry.table.startsWith("relay_account_"),
          );
          expect(constraints).toHaveLength(recorded.length);
          const migration = yield* fs.readFileString(
            `${migrationDirectory}/${deletionMigration}/migration.sql`,
          );
          for (const entry of recorded) {
            expect(
              constraints.find(
                (constraint) =>
                  constraint.table_name === entry.table && constraint.name === entry.name,
              ),
            ).toBeDefined();
            if (entry.entityType === "checks")
              expect(migration).toContain(
                `CONSTRAINT "${String(entry.name)}" CHECK (${String(entry.value)})`,
              );
          }
          const fks = yield* db.$client<{
            delete_action: string;
            update_action: string;
            target: string;
          }>`SELECT p.confdeltype AS delete_action, p.confupdtype AS update_action, target.relname AS target FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class target ON target.oid = p.confrelid WHERE n.nspname = 'task4c_account_deletions' AND c.relname LIKE 'relay_account_%' AND p.contype = 'f'`;
          expect(fks).toEqual(
            Array.from({ length: 2 }, () => ({
              delete_action: "r",
              update_action: "r",
              target: "relay_account_deletions",
            })),
          );
          const triggers = yield* db.$client<{
            table_name: string;
            trigger_name: string;
          }>`SELECT c.relname AS table_name, t.tgname AS trigger_name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'task4c_account_deletions' AND NOT t.tgisinternal ORDER BY c.relname`;
          expect(triggers).toEqual([
            {
              table_name: "relay_account_authorities",
              trigger_name: "account_authority_immutable",
            },
            {
              table_name: "relay_account_deletion_endpoints",
              trigger_name: "account_deletion_endpoint_immutable",
            },
            {
              table_name: "relay_account_deletion_events",
              trigger_name: "account_deletion_event_immutable",
            },
            { table_name: "relay_account_deletions", trigger_name: "account_deletion_monotonic" },
          ]);
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      ),
  );
});
