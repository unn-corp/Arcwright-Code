import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as RelayDb from "../db.ts";
import {
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import { fixtureFile, layerPersistence } from "./incarnationPostgresFixture.ts";
import { registration, state } from "./webPushConsumer.test-fixture.ts";
const owner = "account-A";
const fixture = <A, E>(
  run: (
    db: RelayDb.RelayDb["Service"],
    subscriptions: WebPushSubscriptions.WebPushSubscriptions["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* run(yield* RelayDb.RelayDb, yield* WebPushSubscriptions.WebPushSubscriptions);
  }).pipe(Effect.provide(layerPersistence));
function observe(db: RelayDb.RelayDb["Service"]) {
  return db
    .select()
    .from(relayWebPushSubscriptions)
    .pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (!row) throw new Error("Fixture row missing");
        return row;
      }),
    );
}
function race<A, E, B, F>(
  db: RelayDb.RelayDb["Service"],
  id: string,
  first: Effect.Effect<A, E>,
  second: Effect.Effect<B, F>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const one = yield* Effect.forkChild(
        db.$client.withTransaction(
          Effect.gen(function* () {
            yield* db
              .select()
              .from(relayWebPushSubscriptions)
              .where(eq(relayWebPushSubscriptions.id, id))
              .for("update");
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
            return yield* first;
          }),
        ),
      );
      yield* Deferred.await(locked);
      const two = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          return yield* second;
        }),
      );
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      return [yield* Fiber.join(one), yield* Fiber.join(two)] as const;
    }),
  );
}

describe.runIf(fixtureFile !== undefined)(
  "real PostgreSQL conditional gone-subscription cleanup",
  () => {
    it.effect(
      "removes exactly matching incarnation and baselines; all mismatch predicates leave both untouched",
      () =>
        fixture((db, subscriptions) =>
          Effect.gen(function* () {
            yield* subscriptions.register({ userId: owner, payload: registration });
            yield* subscriptions.transition({ userId: owner, state });
            const row = yield* observe(db);
            for (const change of [
              { userId: "another" },
              { subscriptionId: "another" },
              { subscriptionIncarnationId: "00000000-0000-4000-8000-000000000099" },
            ]) {
              expect(
                yield* subscriptions.removeIfCurrent({
                  userId: owner,
                  subscriptionId: row.id,
                  subscriptionIncarnationId: row.incarnationId,
                  ...change,
                }),
              ).toBe(false);
              expect(yield* observe(db)).toEqual(row);
              expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
            }
            expect(
              yield* subscriptions.removeIfCurrent({
                userId: owner,
                subscriptionId: row.id,
                subscriptionIncarnationId: row.incarnationId,
              }),
            ).toBe(true);
            expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual([]);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
          }),
        ),
    );
    it.effect("rolls back matched subscription deletion when baseline deletion fails", () =>
      fixture((db, subscriptions) =>
        Effect.gen(function* () {
          yield* subscriptions.register({ userId: owner, payload: registration });
          yield* subscriptions.transition({ userId: owner, state });
          const row = yield* observe(db);
          yield* db.$client.unsafe(
            "CREATE FUNCTION consumer_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cleanup failure'; END $$",
          );
          yield* db.$client.unsafe(
            "CREATE TRIGGER consumer_reject_delete BEFORE DELETE ON relay_web_push_subscription_states FOR EACH ROW EXECUTE FUNCTION consumer_reject_delete()",
          );
          const error = yield* Effect.flip(
            subscriptions.removeIfCurrent({
              userId: owner,
              subscriptionId: row.id,
              subscriptionIncarnationId: row.incarnationId,
            }),
          );
          expect(error._tag).toBe("WebPushSubscriptionPersistenceError");
          expect(yield* observe(db)).toEqual(row);
          expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
        }),
      ),
    );
    it.effect.each(
      (["credentials", "owner_A_B_A", "remove_recreate"] as const).flatMap((mutation) =>
        (["replacement_first", "cleanup_first"] as const).map((order) => ({ mutation, order })),
      ),
    )(
      "serializes overlapping %j and protects every new incarnation/baseline",
      ({ mutation, order }) =>
        fixture((db, subscriptions) =>
          Effect.gen(function* () {
            yield* subscriptions.register({ userId: owner, payload: registration });
            yield* subscriptions.transition({ userId: owner, state });
            const original = yield* observe(db);
            const cleanup = subscriptions.removeIfCurrent({
              userId: owner,
              subscriptionId: original.id,
              subscriptionIncarnationId: original.incarnationId,
            });
            const replace = Effect.gen(function* () {
              if (mutation === "owner_A_B_A")
                yield* subscriptions.register({ userId: "account-B", payload: registration });
              if (mutation === "remove_recreate")
                yield* subscriptions.remove({ userId: owner, subscriptionId: original.id });
              yield* subscriptions.register({
                userId: owner,
                payload:
                  mutation === "credentials"
                    ? { ...registration, keys: { p256dh: "new-key", auth: "new-auth" } }
                    : registration,
              });
              yield* TestClock.setTime(1000);
              yield* subscriptions.transition({
                userId: owner,
                state: { ...state, updatedAt: "1970-01-01T00:00:01.000Z" },
              });
              return yield* observe(db);
            });
            if (order === "replacement_first") {
              const [replacement, removed] = yield* race(db, original.id, replace, cleanup);
              expect(removed).toBe(false);
              expect(yield* observe(db)).toEqual(replacement);
            } else {
              const [removed, replacement] = yield* race(db, original.id, cleanup, replace);
              expect(removed).toBe(true);
              expect(yield* observe(db)).toEqual(replacement);
            }
            const current = yield* observe(db);
            expect(current.incarnationId).not.toBe(original.incarnationId);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toMatchObject([
              { subscriptionId: current.id, updatedAt: "1970-01-01T00:00:01.000Z" },
            ]);
          }),
        ),
    );
  },
);
