import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { RelayConfiguration } from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";

// Explicit opt-in only: never infer an ambient relay/database connection.
const fixtureFile = process.env.RELAY_PWA_TEST_FIXTURE_FILE;
class FixtureConfigurationRejected extends Data.TaggedError("FixtureConfigurationRejected") {}
const FixtureConnection = Schema.Struct({
  fixtureOnly: Schema.Literal(true),
  internalDockerOnly: Schema.Literal(true),
  host: Schema.String.pipe(Schema.check(Schema.isPattern(/^192\.168\.\d+\.\d+$/))),
  port: Schema.Literal(5432),
  database: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^arcwright_connect_[a-z0-9_]*fixture[a-z0-9_]*$/)),
  ),
  username: Schema.String,
  password: Schema.String,
  ssl: Schema.Literal(false),
  prepare: Schema.Literal(false),
  containerId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  networkId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  image: Schema.Literal(
    "postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
  ),
});
const decodeFixtureConnection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FixtureConnection),
);
const decodeFixtureReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      fixtureOnly: Schema.Literal(true),
      productionTarget: Schema.Literal(false),
      internalDockerOnly: Schema.Literal(true),
      hostPublishedPorts: Schema.Literal(0),
      host: Schema.String,
      port: Schema.Number,
      containerId: Schema.String,
      networkId: Schema.String,
      image: Schema.String,
    }),
  ),
);

const layerDb = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!fixtureFile) return yield* Effect.die("Explicit disposable fixture file is required.");
    const connection = yield* decodeFixtureConnection(yield* fs.readFileString(fixtureFile)).pipe(
      Effect.mapError(() => new FixtureConfigurationRejected()),
    );
    const receipt = yield* decodeFixtureReceipt(
      yield* fs.readFileString(
        `${fixtureFile.slice(0, fixtureFile.lastIndexOf("/"))}/owned-resources.json`,
      ),
    );
    if (
      receipt.host !== connection.host ||
      receipt.port !== connection.port ||
      receipt.containerId !== connection.containerId ||
      receipt.networkId !== connection.networkId ||
      receipt.image !== connection.image
    ) {
      return yield* Effect.die(
        "Disposable fixture connection does not match its ownership receipt.",
      );
    }
    return Layer.effect(
      RelayDb.RelayDb,
      Effect.gen(function* () {
        const db = yield* PgDrizzle.makeWithDefaults();
        yield* db.$client.unsafe("CREATE SCHEMA IF NOT EXISTS task4c_web_push");
        const tables = yield* db.$client.unsafe<{ exists: string | null }>(
          "SELECT to_regclass('task4c_web_push.relay_web_push_subscriptions')::text AS exists",
        );
        if (!tables[0]?.exists) {
          for (const file of [
            "infra/relay/migrations/postgres/20260802000000_web_push_subscriptions/migration.sql",
            "infra/relay/migrations/postgres/20260803000000_anonymous_pwa_web_push/migration.sql",
          ]) {
            const migration = yield* fs.readFileString(file);
            for (const statement of migration.split("--> statement-breakpoint")) {
              if (statement.trim()) yield* db.$client.unsafe(statement);
            }
          }
        }
        yield* db.$client.unsafe(
          "DROP TRIGGER IF EXISTS task4c_reject_baseline_delete ON relay_web_push_subscription_states",
        );
        yield* db.$client.unsafe("DROP FUNCTION IF EXISTS task4c_reject_baseline_delete()");
        // The schema contains only this test's fixtures; no production table or migration is touched.
        yield* db.$client.unsafe(
          "TRUNCATE relay_web_push_subscriptions, relay_web_push_subscription_states",
        );
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
          startupParameters: { search_path: "task4c_web_push,public" },
          maxConnections: 8,
        }),
      ),
    );
  }),
).pipe(Layer.provide(NodeFileSystem.layer));
const layerSubscriptions = WebPushSubscriptions.layer.pipe(
  Layer.provideMerge(layerDb),
  Layer.provide(NodeCrypto.layer),
);
const preferences = {
  enabled: true,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  showProjectAndThreadNames: false,
};
const payload = {
  endpoint: "https://push.example.test/task4c",
  keys: { p256dh: "key", auth: "auth" },
  preferences,
};
const installation = { installationId: "task4c-installation", installationSecret: "task4c-secret" };
const running = {
  environmentId: EnvironmentId.make("task4c-environment"),
  threadId: ThreadId.make("task4c-thread"),
  projectTitle: "Private Project",
  threadTitle: "Private Thread",
  modelTitle: "Codex",
  phase: "running" as const,
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};

function fixture<A, E>(
  effect: Effect.Effect<A, E, RelayDb.RelayDb | WebPushSubscriptions.WebPushSubscriptions>,
) {
  return effect.pipe(Effect.provide(layerSubscriptions));
}

describe.runIf(fixtureFile !== undefined)(
  "real PostgreSQL PWA ownership conversion (explicit disposable fixture)",
  () => {
    it.effect(
      "allows installation-authenticated cleanup in owned mode without restoring registration or access",
      () =>
        fixture(
          Effect.gen(function* () {
            const legacy = yield* WebPushSubscriptions.WebPushSubscriptions;
            const registered = yield* legacy.registerPwa({
              payload: { ...payload, installation, environmentId: running.environmentId },
            });
            const owned = yield* WebPushSubscriptions.make.pipe(
              Effect.provide(NodeCrypto.layer),
              Effect.provideService(RelayConfiguration, {
                relayIssuer: "https://relay.arcwright.space",
                apns: null,
                clerkSecretKey: Redacted.make("fixture-secret"),
                clerkPublishableKey: `pk_test_${btoa("clerk.arcwright.space$")}`,
                clerkJwtAudience: "arcwright-code-relay",
                clerkAuthPolicy: {
                  mode: "owned",
                  issuer: "https://clerk.arcwright.space",
                  cliClientId: "fixture_cli",
                },
                apnsDeliveryJobSigningSecret: Redacted.make("fixture-secret"),
                cloudMintPrivateKey: Redacted.make("fixture-key"),
                cloudMintPublicKey: "fixture-key",
                managedEndpointBaseDomain: undefined,
                managedEndpointNamespace: undefined,
              }),
            );
            expect(
              yield* owned.removePwa({
                ...installation,
                installationSecret: "wrong",
                subscriptionId: registered.subscriptionId,
              }),
            ).toBe(false);
            expect(
              yield* owned.removePwa({
                ...installation,
                subscriptionId: registered.subscriptionId,
              }),
            ).toBe(true);
            expect(
              (yield* Effect.flip(
                owned.getPwa({ ...installation, subscriptionId: registered.subscriptionId }),
              ))._tag,
            ).toBe("AnonymousPwaUnavailable");
            expect(
              (yield* Effect.flip(
                owned.registerPwa({
                  payload: { ...payload, installation, environmentId: running.environmentId },
                }),
              ))._tag,
            ).toBe("AnonymousPwaUnavailable");
          }),
        ),
    );

    it.effect(
      "converts anonymous ownership and clears its baseline; stale installation cannot get or remove the account row",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const old = yield* subscriptions.registerPwa({
              payload: { ...payload, installation, environmentId: running.environmentId },
            });
            yield* subscriptions.transitionEnvironment({
              environmentId: running.environmentId,
              state: running,
            });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
            expect(yield* subscriptions.register({ userId: "user_task4c", payload })).toEqual(old);
            const row = yield* subscriptions.get({
              userId: "user_task4c",
              subscriptionId: old.subscriptionId,
            });
            expect(row).toMatchObject({
              userId: "user_task4c",
              environmentId: null,
              installationId: null,
              installationSecretHash: null,
            });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            expect(
              yield* subscriptions.getPwa({ ...installation, subscriptionId: old.subscriptionId }),
            ).toBeNull();
            expect(
              yield* subscriptions.removePwa({
                ...installation,
                subscriptionId: old.subscriptionId,
              }),
            ).toBe(false);
            expect(
              yield* subscriptions.get({
                userId: "user_task4c",
                subscriptionId: old.subscriptionId,
              }),
            ).not.toBeNull();
          }),
        ),
    );

    it.effect(
      "preserves a clean same-owner baseline, but clears account-transfer and residual-metadata baselines",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const registered = yield* subscriptions.register({ userId: "user_task4c", payload });
            yield* subscriptions.transition({ userId: "user_task4c", state: running });
            yield* subscriptions.register({ userId: "user_task4c", payload });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
            yield* subscriptions.register({ userId: "user_task4c_next", payload });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            yield* subscriptions.transition({ userId: "user_task4c_next", state: running });
            yield* db
              .update(relayWebPushSubscriptions)
              .set({ installationId: "obsolete-installation" })
              .where(eq(relayWebPushSubscriptions.id, registered.subscriptionId));
            yield* subscriptions.register({ userId: "user_task4c_next", payload });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            expect(
              yield* subscriptions.get({
                userId: "user_task4c_next",
                subscriptionId: registered.subscriptionId,
              }),
            ).toMatchObject({
              environmentId: null,
              installationId: null,
              installationSecretHash: null,
            });
          }),
        ),
    );

    it.effect("rolls back ownership and metadata when baseline cleanup fails", () =>
      fixture(
        Effect.gen(function* () {
          const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
          const db = yield* RelayDb.RelayDb;
          const old = yield* subscriptions.registerPwa({
            payload: { ...payload, installation, environmentId: running.environmentId },
          });
          yield* subscriptions.transitionEnvironment({
            environmentId: running.environmentId,
            state: running,
          });
          yield* db.$client.unsafe(
            "CREATE OR REPLACE FUNCTION task4c_reject_baseline_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'task4c injected baseline delete failure'; END $$",
          );
          yield* db.$client.unsafe(
            "CREATE TRIGGER task4c_reject_baseline_delete BEFORE DELETE ON relay_web_push_subscription_states FOR EACH ROW EXECUTE FUNCTION task4c_reject_baseline_delete()",
          );
          yield* Effect.gen(function* () {
            expect(
              (yield* Effect.flip(subscriptions.register({ userId: "user_task4c", payload })))._tag,
            ).toBe("WebPushSubscriptionPersistenceError");
            const oldRow = yield* subscriptions.getPwa({
              ...installation,
              subscriptionId: old.subscriptionId,
            });
            expect(oldRow).toMatchObject({
              userId: `pwa:${installation.installationId}`,
              environmentId: running.environmentId,
              installationId: installation.installationId,
            });
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
          }).pipe(
            Effect.ensuring(
              db.$client
                .unsafe(
                  "DROP TRIGGER task4c_reject_baseline_delete ON relay_web_push_subscription_states",
                )
                .pipe(
                  Effect.andThen(
                    db.$client.unsafe("DROP FUNCTION task4c_reject_baseline_delete()"),
                  ),
                  Effect.orDie,
                ),
            ),
          );
        }),
      ),
    );

    it.effect(
      "serializes concurrent first registrations at one actual endpoint without inheriting losing ownership",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const results = yield* Effect.all(
              Array.from({ length: 12 }, (_, index) =>
                subscriptions.register({ userId: `user_task4c_${index}`, payload }),
              ),
              { concurrency: 12 },
            );
            expect(new Set(results.map((row) => row.subscriptionId)).size).toBe(1);
            const rows = yield* db.select().from(relayWebPushSubscriptions);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              environmentId: null,
              installationId: null,
              installationSecretHash: null,
            });
            expect(rows[0]?.userId).toMatch(/^user_task4c_\d+$/);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
          }),
        ),
    );
  },
);
