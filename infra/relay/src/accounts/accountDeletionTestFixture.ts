import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import * as RelayDb from "../db.ts";
import * as Fence from "./AccountDeletionFence.ts";
import * as Deletions from "./AccountDeletions.ts";
import { makeVerifiedSubjectPort } from "./ownedSubject.ts";
import { connectDatabase, layerDb } from "./accountDeletionPostgresFixture.ts";

export const configuration = { issuer: "https://accounts.fixture.test", instanceId: "ins_fixture" };
export const setup = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const port = yield* makeVerifiedSubjectPort(configuration);
  const fence = yield* Fence.make(port.authority);
  const deletions = yield* Deletions.make(port.authority);
  return { db, port, fence, deletions };
});
export const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(layerDb)));
export const independentSession = <A, E, R>(effect: Effect.Effect<A, E, R>, lockTimeout?: string) =>
  effect.pipe(Effect.provide(Layer.fresh(connectDatabase(lockTimeout))));
export const writeLimit = (db: RelayDb.RelayDb["Service"], userId: string) =>
  db.$client`INSERT INTO relay_managed_tunnel_limits(user_id, max_tunnels, created_at, updated_at) VALUES (${userId}, 3, 'fixture-created', 'fixture-updated')`;
export const counts = (db: RelayDb.RelayDb["Service"]) => db.$client<{
  authorities: number;
  deletions: number;
  events: number;
  limits: number;
}>`SELECT (SELECT count(*)::integer FROM relay_account_authorities) AS authorities,
  (SELECT count(*)::integer FROM relay_account_deletions) AS deletions,
  (SELECT count(*)::integer FROM relay_account_deletion_events) AS events,
  (SELECT count(*)::integer FROM relay_managed_tunnel_limits) AS limits`;
export const oldRowClasses = [
  "links",
  "allocations",
  "limits",
  "devices",
  "live_activities",
  "subscriptions",
  "attempts",
] as const;
export const seedOldRow = (
  db: RelayDb.RelayDb["Service"],
  kind: (typeof oldRowClasses)[number],
  userId: string,
) => {
  switch (kind) {
    case "links":
      return db.$client`INSERT INTO relay_environment_links(user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url, endpoint_provider_kind, revoked_at, linked_at, created_at, updated_at) VALUES (${userId}, 'old-env', 'old-key', 'https://old.fixture.test', 'wss://old.fixture.test', 'cloudflare_tunnel', 'already-revoked', 'linked', 'created', 'updated')`;
    case "allocations":
      return db.$client`INSERT INTO relay_managed_endpoint_allocations(user_id, environment_id, hostname, tunnel_name, created_at, updated_at) VALUES (${userId}, 'old-env', ${`${userId}.fixture.test`}, ${userId}, 'created', 'updated')`;
    case "limits":
      return writeLimit(db, userId);
    case "devices":
      return db.$client`INSERT INTO relay_mobile_devices(user_id, device_id, platform, preferences_json, created_at, updated_at) VALUES (${userId}, 'old-device', 'android', '{}'::jsonb, 'created', 'updated')`;
    case "live_activities":
      return db.$client`INSERT INTO relay_live_activities(user_id, device_id, ended_at, created_at, updated_at) VALUES (${userId}, 'old-device', 'already-ended', 'created', 'updated')`;
    case "subscriptions":
      return db.$client`INSERT INTO relay_web_push_subscriptions(id, user_id, endpoint, p256dh, auth, preferences_json, created_at, updated_at) VALUES (${userId}, ${userId}, ${`https://${userId}.push.fixture.test`}, 'fixture-key', 'fixture-auth', '{}'::jsonb, 'created', 'updated')`;
    case "attempts":
      return db.$client`INSERT INTO relay_delivery_attempts(id, user_id, created_at, kind) VALUES (${userId}, ${userId}, 'created', 'fixture')`;
  }
};

/** Test-only observer around the actual PgClient, preserving its real
 * transactionService and SQL. The entrant runs in a separately scoped pool. */
export const observeSubjectLock = (
  db: RelayDb.RelayDb["Service"],
  entered: Deferred.Deferred<void>,
) => {
  const client = new Proxy(db.$client, {
    apply(target, receiver, args) {
      const statement = args[0];
      if (Array.isArray(statement) && statement.join("").includes("pg_advisory_xact_lock")) {
        // This is the installed PgClient tagged-statement overload, not an
        // arbitrary Effect. Reflect.apply erases that overload's declaration.
        const result: Effect.Effect<ReadonlyArray<unknown>, SqlError> = Reflect.apply(
          target,
          receiver,
          args,
        );
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(result));
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      return property === "$client" ? client : Reflect.get(target, property, receiver);
    },
  });
};
export const pauseAfterSubjectLock = (
  db: RelayDb.RelayDb["Service"],
  held: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  const client = new Proxy(db.$client, {
    apply(target, receiver, args) {
      const statement = args[0];
      if (Array.isArray(statement) && statement.join("").includes("pg_advisory_xact_lock")) {
        const result: Effect.Effect<ReadonlyArray<unknown>, SqlError> = Reflect.apply(
          target,
          receiver,
          args,
        );
        return result.pipe(
          Effect.tap(() => Deferred.succeed(held, undefined)),
          Effect.tap(() => Deferred.await(release)),
        );
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      return property === "$client" ? client : Reflect.get(target, property, receiver);
    },
  });
};
/** Actual COMMIT succeeds, then the acknowledgement is deliberately lost.
 * This proves retry convergence from SQL state, not a mocked row count. */
export const loseCommitAcknowledgement = (db: RelayDb.RelayDb["Service"]) => {
  const withTransaction: typeof db.$client.withTransaction = (effect) =>
    db.$client
      .withTransaction(effect)
      .pipe(Effect.andThen(Effect.die(new Error("fixture_commit_acknowledgement_lost"))));
  const client = new Proxy(db.$client, {
    get(target, property, receiver) {
      return property === "withTransaction"
        ? withTransaction
        : Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      return property === "$client" ? client : Reflect.get(target, property, receiver);
    },
  });
};
