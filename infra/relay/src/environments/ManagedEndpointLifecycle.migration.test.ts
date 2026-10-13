import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as Lifecycle from "./ManagedEndpointLifecycle.ts";
import { targetFor, type PendingMutation } from "./managedEndpointLifecycleContracts.ts";
import {
  fixtureFile,
  layerDb,
  layerLegacyDb,
  lifecycleMigration,
  migrationDirectory,
  runFixtureMigrations,
} from "./managedEndpointPostgresFixture.ts";

const key = { userId: "migration-user", environmentId: "migration-env" };
const decodeSnapshot = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      dialect: Schema.String,
      prevIds: Schema.Array(Schema.String),
      ddl: Schema.Array(Schema.Unknown),
    }),
  ),
);
const lifecycleLayer = Lifecycle.layer.pipe(
  Layer.provide(Layer.merge(EnvironmentLinks.layer, EnvironmentCredentials.layer)),
  Layer.provide(NodeCrypto.layer),
);
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(lifecycleLayer.pipe(Layer.provideMerge(layerDb)))));
const insert = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  yield* db.$client`INSERT INTO relay_managed_endpoint_allocations(user_id, environment_id, hostname, tunnel_name, created_at, updated_at) VALUES (${key.userId}, ${key.environmentId}, 'migration.fixture.test', 'migration-tunnel', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`;
});

describe.skipIf(!fixtureFile)("ManagedEndpointLifecycle actual PostgreSQL DDL", () => {
  it.effect(
    "ordered old migrations plus legacy seeds quarantine every row without changing resource/history/nullable fields",
    () =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.$client`INSERT INTO relay_managed_endpoint_allocations(user_id, environment_id, hostname, tunnel_name, tunnel_id, dns_record_id, ready_at, origin, recovery_enabled_at, recovery_environment_public_key, tunnel_released_at, generation, created_at, updated_at) VALUES
      ('legacy', 'null', 'null.fixture.test', 'null-tunnel', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 'created-null', 'updated-null'),
      ('legacy', 'complete', 'complete.fixture.test', 'complete-tunnel', 'legacy-tunnel', 'legacy-dns', 'ready', '{"localHttpHost":"localhost","localHttpPort":3000}'::jsonb, 'recovery', 'old-key', NULL, 17, 'created-complete', 'updated-complete'),
      ('legacy', 'marker', 'marker.fixture.test', 'marker-tunnel', NULL, NULL, 'misleading-ready', NULL, NULL, NULL, 'misleading-released', 7, 'created-marker', 'updated-marker')`;
        const before =
          yield* db.$client`SELECT user_id, environment_id, hostname, tunnel_name, tunnel_id, dns_record_id, ready_at, origin, recovery_enabled_at, recovery_environment_public_key, tunnel_released_at, generation, created_at, updated_at FROM relay_managed_endpoint_allocations ORDER BY environment_id`;
        yield* runFixtureMigrations(db, {
          migrationsFolder: migrationDirectory,
          migrationsTable: "relay_migrations",
          migrationsSchema: "task4c_managed_migration",
        });
        const after =
          yield* db.$client`SELECT user_id, environment_id, hostname, tunnel_name, tunnel_id, dns_record_id, ready_at, origin, recovery_enabled_at, recovery_environment_public_key, tunnel_released_at, generation, created_at, updated_at FROM relay_managed_endpoint_allocations ORDER BY environment_id`;
        expect(after).toEqual(before);
        const rows = yield* db.$client<{
          allocation_id: string;
          lifecycle_state: string;
          tunnel_presence: string;
          dns_presence: string;
          operation_id: string | null;
          pending_mutation: unknown;
          cleanup_requested: boolean;
        }>`SELECT allocation_id, lifecycle_state, tunnel_presence, dns_presence, operation_id, pending_mutation, cleanup_requested FROM relay_managed_endpoint_allocations`;
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((row) => row.allocation_id)).size).toBe(3);
        for (const row of rows)
          expect(row).toMatchObject({
            lifecycle_state: "legacy_unverified",
            tunnel_presence: "unresolved",
            dns_presence: "unresolved",
            operation_id: null,
            pending_mutation: null,
            cleanup_requested: false,
          });
        const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
        for (const environmentId of ["null", "complete", "marker"]) {
          const row = yield* lifecycle.get({ userId: "legacy", environmentId });
          if (!row) throw new Error("Legacy fixture row missing");
          expect(
            yield* lifecycle.acquireOperation({
              key: row,
              expectedTarget: targetFor(row),
              kind: "deprovision",
            }),
          ).toEqual({ status: "RepairRequired" });
        }
        yield* insert;
        expect(yield* lifecycle.get(key)).toMatchObject({
          lifecycleState: "legacy_unverified",
          tunnelPresence: "unresolved",
          dnsPresence: "unresolved",
        });
      }).pipe(Effect.provide(Layer.fresh(lifecycleLayer.pipe(Layer.provideMerge(layerLegacyDb))))),
  );

  it.effect(
    "raw SQL cannot violate finite state, owner tuples, recorded identity or bounded action records",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* insert;
          const bad = [
            "lifecycle_state = 'arbitrary'",
            "tunnel_presence = 'guess'",
            "dns_presence = 'guess'",
            "generation = -1",
            "lifecycle_state = 'owned'",
            "operation_id = gen_random_uuid()",
            "operation_kind = 'release'",
            "operation_started_at = 'old'",
            "tunnel_presence = 'recorded'",
            "dns_presence = 'recorded', dns_record_id = 'id'",
            "lifecycle_state = 'uncertain', operation_id = gen_random_uuid(), operation_kind = 'arbitrary', operation_started_at = 'old'",
            "pending_mutation = '{}'::jsonb",
          ];
          for (const update of bad)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client.unsafe(`UPDATE relay_managed_endpoint_allocations SET ${update}`),
                ),
              ),
            ).toBe(true);
          yield* db.$client`UPDATE relay_managed_endpoint_allocations SET lifecycle_state = 'owned', operation_id = gen_random_uuid(), operation_kind = 'provision', operation_started_at = '1900-01-01T00:00:00.000Z'`;
          const invalidPending: readonly unknown[] = [
            { stepId: "invalid", action: "create_tunnel", tunnelName: "name" },
            { stepId: "00000000-0000-4000-8000-000000000001", action: "unknown" },
            { stepId: "00000000-0000-4000-8000-000000000001", action: "create_tunnel" },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "delete_dns",
              dnsRecordId: "id",
              hostname: "host",
            },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "create_tunnel",
              tunnelName: "name",
              secret: "forbidden",
            },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "create_tunnel",
              tunnelName: "x".repeat(2050),
            },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "configure_tunnel",
              tunnelName: "name",
              tunnelId: "id",
              origin: { localHttpHost: "foreign.test", localHttpPort: 3000 },
            },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "configure_tunnel",
              tunnelName: "name",
              tunnelId: "id",
              origin: { localHttpHost: "localhost", localHttpPort: 65536 },
            },
            {
              stepId: "00000000-0000-4000-8000-000000000001",
              action: "configure_tunnel",
              tunnelName: "name",
              tunnelId: "id",
              origin: { localHttpHost: "localhost", localHttpPort: "3000" },
            },
          ];
          for (const pending of invalidPending)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  db.$client`UPDATE relay_managed_endpoint_allocations SET pending_mutation = ${db.$client.json(pending)}`,
                ),
              ),
            ).toBe(true);
          const lifecycle = yield* Lifecycle.ManagedEndpointLifecycle;
          expect(yield* lifecycle.get(key)).toMatchObject({
            lifecycleState: "owned",
            pendingMutation: null,
            generation: 0,
          });
        }),
      ),
  );

  it.effect(
    "all six validated action records and valid owner states pass actual constraints; allocation identity is unique",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          yield* insert;
          yield* db.$client`UPDATE relay_managed_endpoint_allocations SET lifecycle_state = 'owned', operation_id = gen_random_uuid(), operation_kind = 'provision', operation_started_at = 'old-diagnostic'`;
          const stepId = "00000000-0000-4000-8000-000000000001";
          const pending: readonly PendingMutation[] = [
            { action: "create_tunnel", tunnelName: "name", stepId },
            {
              action: "configure_tunnel",
              tunnelId: "id",
              tunnelName: "name",
              origin: { localHttpHost: "::1", localHttpPort: 65535 },
              stepId,
            },
            { action: "delete_tunnel", tunnelId: "id", tunnelName: "name", stepId },
            { action: "create_dns", hostname: "host", tunnelId: "id", stepId },
            {
              action: "update_dns",
              hostname: "host",
              dnsRecordId: "dns",
              previousTunnelId: "old",
              nextTunnelId: "new",
              stepId,
            },
            {
              action: "delete_dns",
              hostname: "host",
              dnsRecordId: "dns",
              previousTunnelId: "old",
              stepId,
            },
          ];
          for (const mutation of pending)
            yield* db.$client`UPDATE relay_managed_endpoint_allocations SET pending_mutation = ${db.$client.json(mutation)}`;
          yield* db.$client`UPDATE relay_managed_endpoint_allocations SET lifecycle_state = 'uncertain'`;
          yield* db.$client`UPDATE relay_managed_endpoint_allocations SET lifecycle_state = 'idle', operation_id = NULL, operation_kind = NULL, operation_started_at = NULL, pending_mutation = NULL, tunnel_presence = 'absent', dns_presence = 'never_created'`;
          const identity = yield* db.$client<{
            allocation_id: string;
          }>`SELECT allocation_id FROM relay_managed_endpoint_allocations`;
          expect(
            Result.isFailure(
              yield* Effect.result(
                db.$client`INSERT INTO relay_managed_endpoint_allocations(user_id, environment_id, hostname, tunnel_name, allocation_id, created_at, updated_at) VALUES ('other', 'other', 'other.fixture.test', 'other-tunnel', ${identity[0]?.allocation_id}::uuid, 'created', 'updated')`,
              ),
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "generated snapshot follows prior snapshot and reflects actual field defaults/checks/indexes",
    () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const fs = yield* FileSystem.FileSystem;
          const snapshot = yield* decodeSnapshot(
            yield* fs.readFileString(`${migrationDirectory}/${lifecycleMigration}/snapshot.json`),
          );
          const previous = yield* decodeSnapshot(
            yield* fs.readFileString(
              `${migrationDirectory}/20261013030258_delivery_incarnations/snapshot.json`,
            ),
          );
          expect(snapshot).toMatchObject({
            version: "8",
            dialect: "postgres",
            prevIds: [previous.id],
          });
          const columns = yield* db.$client<{
            column_name: string;
            column_default: string | null;
            is_nullable: string;
          }>`SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'task4c_managed_endpoints' AND table_name = 'relay_managed_endpoint_allocations'`;
          expect(columns.find((column) => column.column_name === "lifecycle_state")).toMatchObject({
            column_default: "'legacy_unverified'::character varying",
            is_nullable: "NO",
          });
          expect(columns.find((column) => column.column_name === "allocation_id")).toMatchObject({
            column_default: "gen_random_uuid()",
            is_nullable: "NO",
          });
          expect(columns.find((column) => column.column_name === "origin")).toMatchObject({
            is_nullable: "YES",
          });
          const checks = yield* db.$client<{
            conname: string;
          }>`SELECT conname FROM pg_constraint WHERE conrelid = 'task4c_managed_endpoints.relay_managed_endpoint_allocations'::regclass AND contype = 'c' ORDER BY conname`;
          expect(checks.map((check) => check.conname)).toEqual([
            "chk_managed_endpoint_lifecycle_values",
            "chk_managed_endpoint_owner",
            "chk_managed_endpoint_pending",
            "chk_managed_endpoint_recorded_presence",
          ]);
          const indexes = yield* db.$client<{
            indexname: string;
            indexdef: string;
          }>`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'task4c_managed_endpoints' AND tablename = 'relay_managed_endpoint_allocations'`;
          expect(
            indexes.find((index) => index.indexname === "idx_relay_managed_endpoint_allocations_id")
              ?.indexdef,
          ).toContain("UNIQUE INDEX");
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      ),
  );
});
