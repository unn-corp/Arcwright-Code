import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { eq } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { RelayConfiguration } from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";

import { fixtureFile, layerPersistence } from "./incarnationPostgresFixture.ts";

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
  return effect.pipe(Effect.provide(layerPersistence));
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
          const before = yield* subscriptions.getPwa({
            ...installation,
            subscriptionId: old.subscriptionId,
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
            expect(oldRow?.incarnationId).toBe(before?.incarnationId);
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
