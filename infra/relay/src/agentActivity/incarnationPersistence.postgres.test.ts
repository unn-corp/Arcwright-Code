import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayEnvironmentLinkProofPayload } from "@t3tools/contracts/relay";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import {
  relayEnvironmentLinks,
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import {
  fixtureFile,
  incarnationMigration,
  layerLegacyDb,
  layerPersistence,
  migrationConfig,
  migrationDirectory,
  runFixtureMigrations,
} from "./incarnationPostgresFixture.ts";

const environmentId = EnvironmentId.make("incarnation-env");
const endpoint = {
  httpBaseUrl: "https://fixture.arcwright.space",
  wsBaseUrl: "wss://fixture.arcwright.space",
  providerKind: "cloudflare_tunnel" as const,
};
const proof = {
  iss: "fixture",
  aud: "fixture",
  sub: "fixture",
  jti: "fixture",
  iat: 0,
  exp: 60,
  challenge: "fixture",
  environmentId,
  environmentPublicKey: "key-A",
  endpoint,
  origin: { localHttpHost: "localhost", localHttpPort: 3000 },
  scopes: ["agent_activity_notifications"],
  descriptor: {
    environmentId,
    label: "Fixture",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1",
    capabilities: { repositoryIdentity: false },
  },
} satisfies RelayEnvironmentLinkProofPayload;
const linkInput = {
  userId: "account-A",
  proof,
  endpoint,
  request: {
    proof: "fixture",
    notificationsEnabled: true,
    liveActivitiesEnabled: false,
    managedTunnelsEnabled: true,
  },
};
const preferences = {
  enabled: true,
  notifyOnCompletion: true,
  notifyOnPlanReady: true,
  notifyOnInput: true,
  notifyOnFailure: true,
  showProjectAndThreadNames: false,
};
const payload = {
  endpoint: "https://push.example.test/incarnation",
  keys: { p256dh: "key-A", auth: "auth-A" },
  preferences,
};
const installation = { installationId: "install-A", installationSecret: "abc" };
const anonymousPayload = { ...payload, installation, environmentId };
const state = {
  environmentId,
  threadId: ThreadId.make("thread"),
  projectTitle: "Fixture",
  threadTitle: "Fixture",
  modelTitle: "Codex",
  phase: "running" as const,
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class MigrationFixtureError extends Data.TaggedError("MigrationFixtureError")<{
  readonly cause: unknown;
}> {}
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(layerPersistence));

function lockedRace<A, E, B, F, L>(
  db: RelayDb.RelayDb["Service"],
  lock: Effect.Effect<unknown, L>,
  first: Effect.Effect<A, E>,
  second: Effect.Effect<B, F>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const firstFiber = yield* Effect.forkChild(
        db.$client.withTransaction(
          Effect.gen(function* () {
            yield* lock;
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(proceed);
            return yield* first;
          }),
        ),
      );
      yield* Deferred.await(held);
      const secondFiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return yield* second;
        }),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(proceed, undefined);
      const firstResult = yield* Fiber.join(firstFiber);
      const secondResult = yield* Fiber.join(secondFiber);
      return [firstResult, secondResult] as const;
    }),
  );
}

const readLink = (db: RelayDb.RelayDb["Service"], userId = linkInput.userId) =>
  db
    .select()
    .from(relayEnvironmentLinks)
    .where(eq(relayEnvironmentLinks.userId, userId))
    .pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (!row) throw new Error("Missing fixture link");
        return row;
      }),
    );
const readSubscription = (db: RelayDb.RelayDb["Service"]) =>
  db
    .select()
    .from(relayWebPushSubscriptions)
    .pipe(
      Effect.map((rows) => {
        expect(rows).toHaveLength(1);
        const row = rows[0];
        if (!row) throw new Error("Missing fixture subscription");
        return row;
      }),
    );

describe.runIf(fixtureFile !== undefined)(
  "real PostgreSQL durable delivery incarnations (explicit disposable fixture)",
  () => {
    it.effect(
      "keeps original creation provenance and exposes current activation in all public projections",
      () =>
        fixture(
          Effect.gen(function* () {
            const links = yield* EnvironmentLinks.EnvironmentLinks;
            const db = yield* RelayDb.RelayDb;
            yield* TestClock.setTime(1_000);
            yield* links.upsert(linkInput);
            const first = yield* readLink(db);
            expect(first.incarnationId).toMatch(uuid);
            expect(first.linkedAt).toBe("1970-01-01T00:00:01.000Z");
            yield* links.upsert({
              ...linkInput,
              proof: { ...proof, descriptor: { ...proof.descriptor, label: "Renamed" } },
              request: {
                ...linkInput.request,
                notificationsEnabled: false,
                liveActivitiesEnabled: true,
              },
            });
            yield* links.setHoldWebhooksWhileOffline({
              environmentId,
              environmentPublicKey: proof.environmentPublicKey,
              holdWebhooksWhileOffline: true,
            });
            expect(yield* readLink(db)).toMatchObject({
              incarnationId: first.incarnationId,
              linkedAt: first.linkedAt,
              createdAt: first.createdAt,
            });
            yield* links.revokeForUser({ userId: linkInput.userId, environmentId });
            expect(yield* links.getForUser({ userId: linkInput.userId, environmentId })).toBeNull();
            expect(
              yield* links.listDeliveryUsersForEnvironment({
                environmentId,
                environmentPublicKey: proof.environmentPublicKey,
              }),
            ).toEqual([]);
            yield* links.upsert(linkInput);
            const second = yield* readLink(db);
            expect(second.incarnationId).not.toBe(first.incarnationId);
            expect(second.linkedAt).toBe("1970-01-01T00:00:01.001Z");
            expect(second.createdAt).toBe(first.createdAt);
            const listed = yield* links.listForUser({ userId: linkInput.userId });
            const lookedUp = yield* links.getForUser({ userId: linkInput.userId, environmentId });
            const managed = yield* links.findActiveManagedForEnvironment({
              environmentId,
              userId: linkInput.userId,
            });
            for (const publicRow of [listed[0], lookedUp, managed[0]]) {
              expect(publicRow?.linkedAt).toBe(second.linkedAt);
              expect(publicRow).not.toHaveProperty("incarnationId");
              expect(publicRow).not.toHaveProperty("linkIncarnationId");
            }
            expect(
              yield* links.listDeliveryUsersForEnvironment({
                environmentId,
                environmentPublicKey: proof.environmentPublicKey,
              }),
            ).toEqual([
              {
                userId: linkInput.userId,
                linkIncarnationId: second.incarnationId,
                notificationsEnabled: true,
                liveActivitiesEnabled: false,
              },
            ]);
          }),
        ),
    );

    it.effect(
      "rotates A to B to A and managed reactivation monotonically with frozen and backward clocks",
      () =>
        fixture(
          Effect.gen(function* () {
            const links = yield* EnvironmentLinks.EnvironmentLinks;
            const db = yield* RelayDb.RelayDb;
            yield* TestClock.setTime(5_000);
            yield* links.upsert(linkInput);
            const seen = [yield* readLink(db)];
            for (const key of ["key-B", "key-A"]) {
              yield* TestClock.setTime(1_000);
              yield* links.upsert({ ...linkInput, proof: { ...proof, environmentPublicKey: key } });
              seen.push(yield* readLink(db));
            }
            yield* links.upsert({
              ...linkInput,
              request: { ...linkInput.request, managedTunnelsEnabled: false },
            });
            expect((yield* readLink(db)).incarnationId).toBe(seen[2]?.incarnationId);
            yield* links.upsert(linkInput);
            seen.push(yield* readLink(db));
            expect(new Set(seen.map((row) => row.incarnationId)).size).toBe(4);
            expect(seen.map((row) => row.linkedAt)).toEqual([
              "1970-01-01T00:00:05.000Z",
              "1970-01-01T00:00:05.001Z",
              "1970-01-01T00:00:05.002Z",
              "1970-01-01T00:00:05.003Z",
            ]);
            expect(new Set(seen.map((row) => row.createdAt)).size).toBe(1);
          }),
        ),
    );

    it.effect(
      "converges concurrent identical retries and isolates another account's key and activation",
      () =>
        fixture(
          Effect.gen(function* () {
            const links = yield* EnvironmentLinks.EnvironmentLinks;
            const db = yield* RelayDb.RelayDb;
            const results = yield* Effect.all(
              Array.from({ length: 12 }, () =>
                db.$client.withTransaction(
                  links.upsert(linkInput).pipe(Effect.andThen(readLink(db))),
                ),
              ),
              { concurrency: 12 },
            );
            expect(new Set(results.map((row) => row.incarnationId)).size).toBe(1);
            yield* links.upsert({
              ...linkInput,
              userId: "account-B",
              proof: { ...proof, environmentPublicKey: "key-B" },
            });
            const other = yield* readLink(db, "account-B");
            yield* links.upsert({
              ...linkInput,
              proof: { ...proof, environmentPublicKey: "key-B" },
            });
            expect(
              yield* links.listDeliveryUsersForEnvironment({
                environmentId,
                environmentPublicKey: "key-A",
              }),
            ).toEqual([]);
            const shared = yield* links.listDeliveryUsersForEnvironment({
              environmentId,
              environmentPublicKey: "key-B",
            });
            expect(shared.map((row) => row.userId).sort()).toEqual(["account-A", "account-B"]);
            expect(yield* readLink(db, "account-B")).toMatchObject({
              incarnationId: other.incarnationId,
              linkedAt: other.linkedAt,
            });
          }),
        ),
    );

    it.effect.each(
      (["revoke", "key", "managed"] as const).flatMap((firstOperation) =>
        [false, true].map((reverse) => ({
          firstOperation,
          reverse,
          order: reverse ? "reverse" : "forward",
        })),
      ),
    )(
      "serializes actual locked link $firstOperation and upsert in $order order",
      ({ firstOperation, reverse }) =>
        fixture(
          Effect.gen(function* () {
            const links = yield* EnvironmentLinks.EnvironmentLinks;
            const db = yield* RelayDb.RelayDb;
            yield* links.upsert(linkInput);
            const original = yield* readLink(db);
            const changed = Effect.gen(function* () {
              if (firstOperation === "revoke")
                yield* links.revokeForUser({ userId: linkInput.userId, environmentId });
              else
                yield* links.upsert(
                  firstOperation === "key"
                    ? { ...linkInput, proof: { ...proof, environmentPublicKey: "key-B" } }
                    : {
                        ...linkInput,
                        request: { ...linkInput.request, managedTunnelsEnabled: false },
                      },
                );
              return yield* readLink(db);
            });
            const retry = links.upsert(linkInput).pipe(Effect.andThen(readLink(db)));
            const [first, second] = yield* lockedRace(
              db,
              db
                .select()
                .from(relayEnvironmentLinks)
                .where(eq(relayEnvironmentLinks.userId, linkInput.userId))
                .for("update"),
              reverse ? retry : changed,
              reverse ? changed : retry,
            );
            const final = yield* readLink(db);
            expect(final.incarnationId).toBe(second.incarnationId);
            expect(final.createdAt).toBe(original.createdAt);
            if (firstOperation === "key") {
              expect(final.incarnationId).not.toBe(original.incarnationId);
              if (!reverse) expect(final.incarnationId).not.toBe(first.incarnationId);
            } else if (!reverse) {
              expect(final.incarnationId).not.toBe(original.incarnationId);
              expect(Date.parse(final.linkedAt)).toBeGreaterThan(Date.parse(original.linkedAt));
            } else {
              expect(final.incarnationId).toBe(original.incarnationId);
              if (firstOperation === "revoke") expect(final.revokedAt).not.toBeNull();
              else expect(final.managedTunnelsEnabled).toBe(false);
            }
          }),
        ),
    );

    it.effect(
      "rotates account and target credentials without resetting same-owner alert baselines",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const original = yield* subscriptions.register({ userId: "account-A", payload });
            const a = yield* readSubscription(db);
            expect(a.incarnationId).toMatch(uuid);
            yield* subscriptions.transition({ userId: "account-A", state });
            yield* subscriptions.register({
              userId: "account-A",
              payload: {
                ...payload,
                preferences: { ...preferences, enabled: false, showProjectAndThreadNames: true },
              },
            });
            expect((yield* readSubscription(db)).incarnationId).toBe(a.incarnationId);
            for (const keys of [
              { ...payload.keys, p256dh: "key-B" },
              payload.keys,
              { ...payload.keys, auth: "auth-B" },
            ]) {
              const before = yield* readSubscription(db);
              yield* subscriptions.register({ userId: "account-A", payload: { ...payload, keys } });
              expect((yield* readSubscription(db)).incarnationId).not.toBe(before.incarnationId);
              expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
            }
            const beforeTransfer = yield* readSubscription(db);
            yield* subscriptions.register({ userId: "account-B", payload });
            const b = yield* readSubscription(db);
            yield* subscriptions.register({ userId: "account-A", payload });
            const restored = yield* readSubscription(db);
            expect(
              new Set([
                a.incarnationId,
                beforeTransfer.incarnationId,
                b.incarnationId,
                restored.incarnationId,
              ]).size,
            ).toBe(4);
            expect(restored.id).toBe(original.subscriptionId);
            expect(restored.createdAt).toBe(a.createdAt);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            yield* subscriptions.remove({
              userId: "account-A",
              subscriptionId: original.subscriptionId,
            });
            yield* subscriptions.register({ userId: "account-A", payload });
            expect((yield* readSubscription(db)).incarnationId).not.toBe(restored.incarnationId);
          }),
        ),
    );

    it.effect(
      "audits anonymous environment, credential tuple, preferences and installation transfers",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const registered = yield* subscriptions.registerPwa({ payload: anonymousPayload });
            const original = yield* readSubscription(db);
            expect(original.installationSecretHash).toBe(
              "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
            );
            yield* subscriptions.transitionEnvironment({ environmentId, state });
            yield* subscriptions.registerPwa({
              payload: { ...anonymousPayload, preferences: { ...preferences, enabled: false } },
            });
            expect((yield* readSubscription(db)).incarnationId).toBe(original.incarnationId);
            for (const changed of [
              { ...anonymousPayload, environmentId: EnvironmentId.make("other-env") },
              anonymousPayload,
              { ...anonymousPayload, endpoint: "https://push.example.test/other" },
              anonymousPayload,
              { ...anonymousPayload, keys: { ...payload.keys, p256dh: "key-B" } },
              { ...anonymousPayload, keys: { ...payload.keys, auth: "auth-B" } },
              anonymousPayload,
            ]) {
              const before = yield* readSubscription(db);
              yield* subscriptions.registerPwa({ payload: changed });
              const after = yield* readSubscription(db);
              expect(after.incarnationId).not.toBe(before.incarnationId);
              expect(after.id).toBe(registered.subscriptionId);
              expect(after.createdAt).toBe(original.createdAt);
              expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
            }
            const beforeInvalidSecret = yield* readSubscription(db);
            expect(
              (yield* Effect.flip(
                subscriptions.registerPwa({
                  payload: {
                    ...anonymousPayload,
                    installation: { ...installation, installationSecret: "wrong" },
                  },
                }),
              ))._tag,
            ).toBe("WebPushSubscriptionPersistenceError");
            expect(yield* readSubscription(db)).toEqual(beforeInvalidSecret);
            yield* subscriptions.registerPwa({
              payload: {
                ...anonymousPayload,
                installation: { installationId: "install-B", installationSecret: "secret-B" },
              },
            });
            const transferred = yield* readSubscription(db);
            yield* subscriptions.registerPwa({ payload: anonymousPayload });
            const returned = yield* readSubscription(db);
            expect(
              new Set([original.incarnationId, transferred.incarnationId, returned.incarnationId])
                .size,
            ).toBe(3);
            expect(returned.id).not.toBe(registered.subscriptionId);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            yield* subscriptions.register({ userId: "account-A", payload });
            const owned = yield* readSubscription(db);
            expect(owned.incarnationId).not.toBe(returned.incarnationId);
            expect(owned).toMatchObject({
              environmentId: null,
              installationId: null,
              installationSecretHash: null,
            });
            expect(
              yield* subscriptions.removePwa({ ...installation, subscriptionId: owned.id }),
            ).toBe(false);
          }),
        ),
    );

    it.effect.each([false, true])(
      "serializes anonymous credentials and account conversion (reverse: %s)",
      (reverse) =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            yield* subscriptions.registerPwa({ payload: anonymousPayload });
            const original = yield* readSubscription(db);
            const replace = subscriptions
              .registerPwa({
                payload: { ...anonymousPayload, keys: { p256dh: "key-B", auth: "auth-B" } },
              })
              .pipe(Effect.andThen(readSubscription(db)));
            const convert = subscriptions
              .register({ userId: "account-A", payload })
              .pipe(Effect.andThen(readSubscription(db)));
            const [first, second] = yield* lockedRace(
              db,
              db
                .execute(
                  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web-push:endpoint:${payload.endpoint}`}, 0))`,
                )
                .pipe(
                  Effect.andThen(
                    db
                      .select()
                      .from(relayWebPushSubscriptions)
                      .where(eq(relayWebPushSubscriptions.endpoint, payload.endpoint))
                      .for("update"),
                  ),
                ),
              reverse ? convert : replace,
              reverse ? replace : convert,
            );
            expect(first.incarnationId).not.toBe(original.incarnationId);
            expect(second.incarnationId).not.toBe(first.incarnationId);
            expect((yield* readSubscription(db)).incarnationId).toBe(second.incarnationId);
            if (reverse) expect(second.installationId).toBe(installation.installationId);
            else {
              expect(second.userId).toBe("account-A");
              expect(
                yield* subscriptions.removePwa({ ...installation, subscriptionId: second.id }),
              ).toBe(false);
            }
          }),
        ),
    );

    it.effect.each([false, true])(
      "handles twelve concurrent first registrations (same owner: %s)",
      (sameOwner) =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const rows = yield* Effect.all(
              Array.from({ length: 12 }, (_, index) =>
                db.$client.withTransaction(
                  subscriptions
                    .register({ userId: sameOwner ? "account-A" : `account-${index}`, payload })
                    .pipe(Effect.andThen(readSubscription(db))),
                ),
              ),
              { concurrency: 12 },
            );
            expect(new Set(rows.map((row) => row.id)).size).toBe(1);
            expect(new Set(rows.map((row) => row.incarnationId)).size).toBe(sameOwner ? 1 : 12);
            expect(rows.map((row) => row.incarnationId)).toContain(
              (yield* readSubscription(db)).incarnationId,
            );
          }),
        ),
    );

    it.effect("gives concurrent genuine link-key transitions separate incarnations", () =>
      fixture(
        Effect.gen(function* () {
          const links = yield* EnvironmentLinks.EnvironmentLinks;
          const db = yield* RelayDb.RelayDb;
          yield* links.upsert(linkInput);
          const original = yield* readLink(db);
          const rows = yield* Effect.all(
            Array.from({ length: 12 }, (_, index) =>
              db.$client.withTransaction(
                links
                  .upsert({
                    ...linkInput,
                    proof: { ...proof, environmentPublicKey: `replacement-${index}` },
                  })
                  .pipe(Effect.andThen(readLink(db))),
              ),
            ),
            { concurrency: 12 },
          );
          expect(new Set(rows.map((row) => row.incarnationId)).size).toBe(12);
          expect(new Set(rows.map((row) => row.linkedAt)).size).toBe(12);
          for (const row of rows) {
            expect(row.incarnationId).not.toBe(original.incarnationId);
            expect(row.createdAt).toBe(original.createdAt);
          }
        }),
      ),
    );

    it.effect.each([true, false])(
      "serializes twelve anonymous first registrations (same installation: %s)",
      (sameInstallation) =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            const rows = yield* Effect.all(
              Array.from({ length: 12 }, (_, index) =>
                db.$client.withTransaction(
                  subscriptions
                    .registerPwa({
                      payload: {
                        ...anonymousPayload,
                        installation: sameInstallation
                          ? installation
                          : {
                              installationId: `installation-${index}`,
                              installationSecret: "abc",
                            },
                      },
                    })
                    .pipe(Effect.andThen(readSubscription(db))),
                ),
              ),
              { concurrency: 12 },
            );
            expect(new Set(rows.map((row) => row.incarnationId)).size).toBe(
              sameInstallation ? 1 : 12,
            );
            expect(rows.map((row) => row.incarnationId)).toContain(
              (yield* readSubscription(db)).incarnationId,
            );
          }),
        ),
    );

    it.effect.each(
      (["owner", "credentials", "preferences"] as const).flatMap((change) =>
        [false, true].map((reverse) => ({
          change,
          reverse,
          order: reverse ? "reverse" : "forward",
        })),
      ),
    )(
      "observes actual transition snapshot and $change update in $order order",
      ({ change, reverse }) =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            yield* subscriptions.register({ userId: "account-A", payload });
            yield* subscriptions.transition({ userId: "account-A", state });
            const original = yield* readSubscription(db);
            const snapshot = subscriptions.transition({
              userId: "account-A",
              state: { ...state, phase: "completed", updatedAt: "1970-01-01T00:00:01.000Z" },
            });
            const mutate = subscriptions
              .register({
                userId: change === "owner" ? "account-B" : "account-A",
                payload:
                  change === "credentials"
                    ? { ...payload, keys: { p256dh: "key-B", auth: "auth-B" } }
                    : change === "preferences"
                      ? {
                          ...payload,
                          preferences: { ...preferences, showProjectAndThreadNames: true },
                        }
                      : payload,
              })
              .pipe(Effect.as([]));
            // Both operations read the actual locked subscription. A snapshot taken
            // before replacement can only carry the old identity; after an account
            // transfer the previous account cannot obtain a transition snapshot.
            const [first, second] = yield* lockedRace(
              db,
              db
                .execute(
                  sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web-push:endpoint:${payload.endpoint}`}, 0))`,
                )
                .pipe(
                  Effect.andThen(
                    db
                      .select()
                      .from(relayWebPushSubscriptions)
                      .where(eq(relayWebPushSubscriptions.endpoint, payload.endpoint))
                      .for("update"),
                  ),
                ),
              reverse ? mutate : snapshot,
              reverse ? snapshot : mutate,
            );
            const current = yield* readSubscription(db);
            const notifications = reverse ? second : first;
            if (reverse && change === "owner") expect(notifications).toEqual([]);
            else {
              expect(notifications).toHaveLength(1);
              expect(notifications[0]?.subscription.incarnationId).toBe(
                reverse ? current.incarnationId : original.incarnationId,
              );
            }
            if (change === "preferences")
              expect(current.incarnationId).toBe(original.incarnationId);
            else expect(current.incarnationId).not.toBe(original.incarnationId);
          }),
        ),
    );

    it.effect(
      "rolls back anonymous endpoint transfer, incarnation and baseline on cleanup failure",
      () =>
        fixture(
          Effect.gen(function* () {
            const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
            const db = yield* RelayDb.RelayDb;
            yield* subscriptions.registerPwa({ payload: anonymousPayload });
            yield* subscriptions.transitionEnvironment({ environmentId, state });
            const original = yield* readSubscription(db);
            yield* db.$client.unsafe(
              "CREATE FUNCTION incarnation_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected fixture failure'; END $$",
            );
            yield* db.$client.unsafe(
              "CREATE TRIGGER incarnation_reject_delete BEFORE DELETE ON relay_web_push_subscription_states FOR EACH ROW EXECUTE FUNCTION incarnation_reject_delete()",
            );
            expect(
              (yield* Effect.flip(
                subscriptions.registerPwa({
                  payload: {
                    ...anonymousPayload,
                    installation: { installationId: "install-B", installationSecret: "secret-B" },
                  },
                }),
              ))._tag,
            ).toBe("WebPushSubscriptionPersistenceError");
            expect(yield* readSubscription(db)).toEqual(original);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
          }),
        ),
    );

    it.effect("provides PostgreSQL 16 builtin UUID defaults to inherited table-DML roles", () =>
      fixture(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
          const links = yield* EnvironmentLinks.EnvironmentLinks;
          const capability = yield* db.$client.unsafe<{ builtin: boolean; executable: boolean }>(
            "SELECT p.pronamespace = 'pg_catalog'::regnamespace AS builtin, has_function_privilege(current_user, p.oid, 'EXECUTE') AS executable FROM pg_proc p WHERE p.oid = 'pg_catalog.gen_random_uuid()'::regprocedure",
          );
          expect(capability[0]).toEqual({ builtin: true, executable: true });
          const pk = yield* db.$client.unsafe<{ conname: string }>(
            "SELECT conname FROM pg_constraint WHERE conrelid = 'relay_web_push_subscription_states'::regclass AND contype = 'p'",
          );
          expect(pk[0]?.conname).toBe(
            "relay_web_push_subscription_states_subscription_id_environment_",
          );
          yield* db.$client.withTransaction(
            Effect.gen(function* () {
              yield* db.$client.unsafe("CREATE ROLE task4c_incarnation_runtime NOLOGIN INHERIT");
              yield* db.$client.unsafe(
                "GRANT pg_read_all_data, pg_write_all_data TO task4c_incarnation_runtime",
              );
              yield* db.$client.unsafe("SET LOCAL ROLE task4c_incarnation_runtime");
              yield* db.$client.unsafe(
                "INSERT INTO relay_web_push_subscriptions (id,user_id,endpoint,p256dh,auth,preferences_json,created_at,updated_at) VALUES ('runtime','account','https://push.example.test/runtime','key','auth','{}','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')",
              );
              const rows = yield* db.$client.unsafe<{ incarnation_id: string }>(
                "SELECT incarnation_id FROM relay_web_push_subscriptions WHERE id = 'runtime'",
              );
              expect(rows[0]?.incarnation_id).toMatch(uuid);
              yield* subscriptions.register({ userId: "runtime-account", payload });
              yield* subscriptions.register({
                userId: "runtime-account",
                payload: { ...payload, keys: { p256dh: "replaced", auth: "replaced" } },
              });
              yield* subscriptions.registerPwa({ payload: anonymousPayload });
              yield* links.upsert(linkInput);
              yield* links.upsert({
                ...linkInput,
                proof: { ...proof, environmentPublicKey: "key-B" },
              });
              yield* db.$client.unsafe("RESET ROLE");
              yield* db.$client.unsafe("DROP OWNED BY task4c_incarnation_runtime");
              yield* db.$client.unsafe("DROP ROLE task4c_incarnation_runtime");
            }),
          );
        }),
      ),
    );
  },
);

const legacyFixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(layerLegacyDb, NodeFileSystem.layer)));
const insertHistoricalLink = (db: RelayDb.RelayDb["Service"], userId: string, date: string) =>
  db.$client.unsafe(
    "INSERT INTO relay_environment_links (user_id,environment_id,environment_public_key,endpoint_http_base_url,endpoint_ws_base_url,endpoint_provider_kind,created_at,updated_at) VALUES ($1,'old-env','old-key','https://fixture.test','wss://fixture.test','cloudflare_tunnel',$2,$2)",
    [userId, date],
  );
const applyCurrentMigrations = (db: RelayDb.RelayDb["Service"]) =>
  runFixtureMigrations(db, {
    ...migrationConfig,
    migrationsSchema: "task4c_incarnation_migration",
  }).pipe(Effect.mapError((cause) => new MigrationFixtureError({ cause })));

describe.runIf(fixtureFile !== undefined)(
  "ordered incarnation migration against previous real schema",
  () => {
    it.effect(
      "backfills exact original ISO bytes and fresh UUID per row, then reruns bookkeeping without rotation",
      () =>
        legacyFixture(
          Effect.gen(function* () {
            const db = yield* RelayDb.RelayDb;
            for (const [userId, date] of [
              ["old-A", "2026-09-01T12:34:56.123Z"],
              ["old-B", "2026-09-01T14:34:56.123+02:00"],
            ]) {
              if (userId && date) yield* insertHistoricalLink(db, userId, date);
            }
            yield* db.$client.unsafe(
              "INSERT INTO relay_web_push_subscriptions (id,user_id,endpoint,p256dh,auth,preferences_json,created_at,updated_at) VALUES ('old-A','account-A','https://push.example.test/old-A','key','auth','{}','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),('old-B','account-B','https://push.example.test/old-B','key','auth','{}','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')",
            );
            yield* applyCurrentMigrations(db);
            const before = yield* db
              .select()
              .from(relayEnvironmentLinks)
              .orderBy(relayEnvironmentLinks.userId);
            expect(before.map((row) => row.linkedAt)).toEqual(before.map((row) => row.createdAt));
            expect(before.map((row) => row.environmentLabel)).toEqual([
              "T3 Environment",
              "T3 Environment",
            ]);
            const subscriptions = yield* db.select().from(relayWebPushSubscriptions);
            expect(
              new Set([...before, ...subscriptions].map((row) => row.incarnationId)).size,
            ).toBe(4);
            for (const row of [...before, ...subscriptions])
              expect(row.incarnationId).toMatch(uuid);
            yield* applyCurrentMigrations(db);
            expect(
              yield* db.select().from(relayEnvironmentLinks).orderBy(relayEnvironmentLinks.userId),
            ).toEqual(before);
            expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual(subscriptions);
            const records = yield* db.$client.unsafe<{ name: string; hash: string }>(
              "SELECT name, hash FROM relay_migrations ORDER BY created_at",
            );
            const fs = yield* FileSystem.FileSystem;
            expect(records.map((row) => row.name)).toEqual(
              (yield* fs.readDirectory(migrationDirectory)).sort(),
            );
            expect(records.filter((row) => row.name === incarnationMigration)).toHaveLength(1);
            const sourceMigrations = yield* Effect.try({
              try: () => readMigrationFiles({ migrationsFolder: migrationDirectory }),
              catch: (cause) => new MigrationFixtureError({ cause }),
            });
            expect(records).toEqual(sourceMigrations.map(({ name, hash }) => ({ name, hash })));
          }),
        ),
    );

    it.effect.each(["not-a-date", "2026-02-30T00:00:00.000Z"])(
      "rejects invalid historical date %s without partial schema or provenance changes",
      (invalid) =>
        legacyFixture(
          Effect.gen(function* () {
            const db = yield* RelayDb.RelayDb;
            yield* insertHistoricalLink(db, "invalid", invalid);
            expect((yield* Effect.flip(applyCurrentMigrations(db)))._tag).toBe(
              "MigrationFixtureError",
            );
            const columns = yield* db.$client.unsafe<{ column_name: string }>(
              "SELECT column_name FROM information_schema.columns WHERE table_schema = 'task4c_incarnation_migration' AND column_name IN ('linked_at','incarnation_id')",
            );
            expect(columns).toEqual([]);
            const rows = yield* db.$client.unsafe<{ created_at: string }>(
              "SELECT created_at FROM relay_environment_links",
            );
            expect(rows[0]?.created_at).toBe(invalid);
            expect(
              yield* db.$client.unsafe("SELECT name FROM relay_migrations WHERE name = $1", [
                incarnationMigration,
              ]),
            ).toEqual([]);
          }),
        ),
    );
  },
);
