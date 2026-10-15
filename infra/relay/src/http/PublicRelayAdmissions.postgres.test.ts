import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { EffectLogger } from "drizzle-orm/effect-core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayManagedEndpointRecoveryRequest } from "@t3tools/contracts/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { eq } from "drizzle-orm";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Db from "../db.ts";
import * as Configuration from "../Config.ts";
import * as Links from "../environments/EnvironmentLinks.ts";
import * as Subscriptions from "../agentActivity/WebPushSubscriptions.ts";
import { fixtureFile, layerPersistence } from "../agentActivity/incarnationPostgresFixture.ts";
import {
  relayEnvironmentLinks,
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";
import {
  config,
  counters,
  fixture,
  installation,
  subscriptionPayload,
  requestForOperation,
  send,
} from "./publicRelayAdmissions.test-fixture.ts";
import { relayKeys } from "./publicRelayProofs.test-fixture.ts";
import * as Limits from "./PublicRelayRateLimits.ts";
const decodeRecovery = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayManagedEndpointRecoveryRequest),
);
const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.Struct({ subscriptionId: Schema.String }),
);
const legacyConfig: Configuration.RelayConfiguration["Service"] = {
  ...config,
  clerkAuthPolicy: { mode: "legacy" },
};
const withPg = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(layerPersistence));
const registration = {
  ...subscriptionPayload,
  environmentId: EnvironmentId.make("env"),
  installation,
};
const state = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Fixture",
  threadTitle: "Fixture",
  modelTitle: "Fixture",
  phase: "running" as const,
  headline: "Running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
};
const makeSubscriptions = (
  settings: Configuration.RelayConfiguration["Service"],
  c: ReturnType<typeof counters>,
) =>
  Subscriptions.make.pipe(
    Effect.provideService(Configuration.RelayConfiguration, settings),
    Effect.provide(
      Layer.effect(
        Crypto.Crypto,
        Crypto.Crypto.pipe(
          Effect.map((base) => ({
            ...base,
            randomUUIDv4: ((options?: Parameters<Crypto.Crypto["randomUUIDv4"]>[0]) =>
              base
                .randomUUIDv4(options)
                .pipe(
                  Effect.tap(() => Effect.sync(() => c.uuid++)),
                )) as Crypto.Crypto["randomUUIDv4"],
          })),
        ),
      ).pipe(Layer.provide(NodeCrypto.layer)),
    ),
  );
const currentRequest = Effect.fnUntraced(function* (
  op:
    | "registerPwaWebPushSubscription"
    | "testPwaWebPushSubscription"
    | "removePwaWebPushSubscription",
  subscriptionId: string,
  secret = installation.installationSecret,
) {
  const req = yield* requestForOperation(op, {
    payload:
      op === "registerPwaWebPushSubscription"
        ? { ...registration, installation: { ...installation, installationSecret: secret } }
        : { installation: { ...installation, installationSecret: secret } },
  });
  return new Request(
    req.url.replace(/\/subscription(?=\/(?:test|remove)|$)/, `/${subscriptionId}`),
    { method: req.method, headers: req.headers, body: yield* Effect.promise(() => req.text()) },
  );
});
const limited = (mode: "deny" | "outage") =>
  mode === "deny"
    ? Effect.fail(new Limits.PublicRelayRateLimited({ retryAfterSeconds: 60 }))
    : Effect.fail(new Limits.PublicRelayLimiterUnavailable({}));
const insertLink = (
  db: Db.RelayDb["Service"],
  userId: string,
  options: { readonly managed?: boolean; readonly key?: string; readonly hold?: boolean } = {},
) =>
  db.insert(relayEnvironmentLinks).values({
    userId,
    environmentId: "env",
    environmentPublicKey: options.key ?? relayKeys.publicKey,
    endpointHttpBaseUrl: "https://0123456789abcdef.example.test/",
    endpointWsBaseUrl: "wss://0123456789abcdef.example.test/ws",
    endpointProviderKind: options.managed ? "cloudflare_tunnel" : "manual",
    managedTunnelsEnabled: options.managed ?? false,
    holdWebhooksWhileOffline: options.hold ?? true,
    notificationsEnabled: true,
    liveActivitiesEnabled: false,
    linkedAt: "1970-01-01T00:00:00.000Z",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  });
describe.runIf(fixtureFile !== undefined)(
  "real PostgreSQL public admission ownership races",
  () => {
    for (const operation of [
      "registerPwaWebPushSubscription",
      "removePwaWebPushSubscription",
      "testPwaWebPushSubscription",
    ] as const) {
      it.effect.each(["deny", "outage"] as const)(
        `${operation} %s after current secret authentication leaves SQL and queues unchanged`,
        (mode) =>
          withPg(
            Effect.gen(function* () {
              const c = counters();
              const subscriptions = yield* makeSubscriptions(legacyConfig, c);
              const db = yield* Db.RelayDb;
              const registered = yield* subscriptions.registerPwa({ payload: registration });
              yield* subscriptions.transitionEnvironment({ environmentId: "env", state });
              c.uuid = 0;
              const beforeRows = yield* db.select().from(relayWebPushSubscriptions);
              const beforeStates = yield* db.select().from(relayWebPushSubscriptionStates);
              const subjects: Limits.PublicRelaySubject[] = [];
              const endpoint = yield* fixture({
                counts: c,
                config: legacyConfig,
                subscriptions,
                admit: (op, subject) => {
                  if (subject.kind === "edge") return Effect.void;
                  expect(op).toBe(operation);
                  subjects.push(subject);
                  return limited(mode);
                },
              });
              const response = yield* send(
                endpoint,
                yield* currentRequest(operation, registered.subscriptionId),
              );
              expect(response.status).toBe(mode === "deny" ? 429 : 503);
              expect(subjects).toEqual([
                { kind: "installation", installationId: installation.installationId },
              ]);
              expect(c.uuid).toBe(0);
              expect(c.queues).toBe(0);
              expect(c.replay).toBe(0);
              expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual(beforeRows);
              expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual(beforeStates);
            }),
          ).pipe(Effect.scoped),
      );
    }
    it.effect(
      "anonymous first-create is edge-only; wrong existing credential never becomes first-create",
      () =>
        withPg(
          Effect.gen(function* () {
            const c = counters();
            const subscriptions = yield* makeSubscriptions(legacyConfig, c);
            const subjects: Limits.PublicRelaySubject[] = [];
            const endpoint = yield* fixture({
              counts: c,
              config: legacyConfig,
              subscriptions,
              admit: (_, subject) =>
                Effect.sync(() => {
                  subjects.push(subject);
                }),
            });
            const response = yield* send(
              endpoint,
              yield* requestForOperation("registerPwaWebPushSubscription"),
            );
            expect(response.status).toBe(200);
            expect(subjects).toEqual([{ kind: "edge", ip: "192.0.2.4" }]);
            const registrationBody = yield* Effect.promise(() => response.json());
            const decoded = yield* decodeRegistration(registrationBody);
            c.uuid = 0;
            subjects.length = 0;
            expect(
              (yield* send(
                endpoint,
                yield* currentRequest(
                  "registerPwaWebPushSubscription",
                  decoded.subscriptionId,
                  "wrong-secret",
                ),
              )).status,
            ).toBe(500);
            expect(c.uuid).toBe(0);
            expect(subjects).toEqual([{ kind: "edge", ip: "192.0.2.4" }]);
            expect(
              yield* subscriptions.getPwa({
                ...installation,
                subscriptionId: decoded.subscriptionId,
              }),
            ).not.toBeNull();
          }),
        ).pipe(Effect.scoped),
    );
    it.effect(
      "owned mode blocks anonymous config/register/test/publication and permits gated credentialed cleanup",
      () =>
        withPg(
          Effect.gen(function* () {
            const c = counters();
            const legacy = yield* makeSubscriptions(legacyConfig, c);
            const registered = yield* legacy.registerPwa({ payload: registration });
            const owned = yield* makeSubscriptions(config, c);
            const subjects: Limits.PublicRelaySubject[] = [];
            const endpoint = yield* fixture({
              counts: c,
              subscriptions: owned,
              admit: (_, subject) =>
                Effect.sync(() => {
                  subjects.push(subject);
                }),
            });
            for (const op of [
              "getPwaWebPushConfig",
              "registerPwaWebPushSubscription",
              "testPwaWebPushSubscription",
              "publishPwaAgentActivity",
            ] as const)
              expect((yield* send(endpoint, yield* requestForOperation(op))).status).toBe(500);
            expect(subjects.every((subject) => subject.kind === "edge")).toBe(true);
            expect(
              (yield* send(
                endpoint,
                yield* currentRequest("removePwaWebPushSubscription", registered.subscriptionId),
              )).status,
            ).toBe(200);
            expect(subjects.at(-1)).toEqual({
              kind: "installation",
              installationId: installation.installationId,
            });
            expect(
              yield* owned.getPwaForCleanup({
                ...installation,
                subscriptionId: registered.subscriptionId,
              }),
            ).toBeNull();
            expect(
              (yield* Effect.flip(
                owned.getPwa({ ...installation, subscriptionId: registered.subscriptionId }),
              ))._tag,
            ).toBe("AnonymousPwaUnavailable");
          }),
        ).pipe(Effect.scoped),
    );
    it.effect.each(["deny", "outage"] as const)(
      "anonymous signed publication %s has verified key authority and preserves its nonce",
      (mode) =>
        withPg(
          Effect.gen(function* () {
            const c = counters();
            const subscriptions = yield* makeSubscriptions(legacyConfig, c);
            const db = yield* Db.RelayDb;
            yield* subscriptions.registerPwa({ payload: registration });
            c.uuid = 0;
            let blocking = true;
            const subjects: Limits.PublicRelaySubject[] = [];
            const endpoint = yield* fixture({
              counts: c,
              config: legacyConfig,
              subscriptions,
              admit: (_, subject) => {
                if (subject.kind === "edge") return Effect.void;
                subjects.push(subject);
                return blocking ? limited(mode) : Effect.void;
              },
            });
            const request = yield* requestForOperation("publishPwaAgentActivity");
            const body = yield* Effect.promise(() => request.text());
            const retry = () =>
              new Request(request.url, { method: request.method, headers: request.headers, body });
            expect((yield* send(endpoint, retry())).status).toBe(mode === "deny" ? 429 : 503);
            expect(subjects).toEqual([
              { kind: "environment", environmentId: "env", keyDigest: expect.any(String) },
            ]);
            expect(c.replay).toBe(0);
            expect(c.queues).toBe(0);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
            blocking = false;
            expect((yield* send(endpoint, retry())).status).toBe(200);
            expect(c.replay).toBe(1);
            const replay = yield* send(endpoint, retry());
            expect(replay.status).toBe(401);
            expect(yield* Effect.promise(() => replay.json())).toMatchObject({
              reason: "replayed_nonce",
            });
          }),
        ).pipe(Effect.scoped),
    );
    it.effect("legacy PWA config uses one mandatory edge gate with no invented identity", () =>
      withPg(
        Effect.gen(function* () {
          const c = counters();
          const subscriptions = yield* makeSubscriptions(legacyConfig, c);
          const subjects: Limits.PublicRelaySubject[] = [];
          const endpoint = yield* fixture({
            counts: c,
            config: legacyConfig,
            subscriptions,
            admit: (_, subject) =>
              Effect.sync(() => {
                subjects.push(subject);
              }),
          });
          expect(
            (yield* send(endpoint, yield* requestForOperation("getPwaWebPushConfig"))).status,
          ).toBe(200);
          expect(subjects).toEqual([{ kind: "edge", ip: "192.0.2.4" }]);
        }),
      ).pipe(Effect.scoped),
    );
    it.effect.each(["renewal", "remove"] as const)(
      "awaited PWA %s cannot mutate an account replacement or purge its baseline",
      (operation) =>
        withPg(
          Effect.gen(function* () {
            const c = counters();
            const subscriptions = yield* makeSubscriptions(legacyConfig, c);
            const db = yield* Db.RelayDb;
            const registered = yield* subscriptions.registerPwa({ payload: registration });
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            const endpoint = yield* fixture({
              counts: c,
              config: legacyConfig,
              subscriptions,
              admit: (_, subject) =>
                subject.kind === "installation"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                    )
                  : Effect.void,
            });
            const fiber = yield* send(
              endpoint,
              yield* currentRequest(
                operation === "renewal"
                  ? "registerPwaWebPushSubscription"
                  : "removePwaWebPushSubscription",
                registered.subscriptionId,
              ),
            ).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const account = yield* subscriptions.register({
              userId: "user_replacement",
              payload: subscriptionPayload,
            });
            yield* subscriptions.transition({ userId: "user_replacement", state });
            const beforeRows = yield* db.select().from(relayWebPushSubscriptions);
            const beforeStates = yield* db.select().from(relayWebPushSubscriptionStates);
            expect(beforeStates).toHaveLength(1);
            yield* Deferred.succeed(resume, undefined);
            const response = yield* Fiber.join(fiber);
            expect(response.status).toBe(operation === "renewal" ? 500 : 200);
            if (operation === "remove")
              expect(yield* Effect.promise(() => response.json())).toMatchObject({ ok: false });
            expect(account.subscriptionId).toBe(registered.subscriptionId);
            expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual(beforeRows);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual(beforeStates);
          }),
        ).pipe(Effect.scoped),
    );
    it.effect(
      "same-ID installation rotation while removal awaits preserves replacement incarnation and baselines",
      () =>
        withPg(
          Effect.gen(function* () {
            const c = counters();
            const subscriptions = yield* makeSubscriptions(legacyConfig, c);
            const db = yield* Db.RelayDb;
            const registered = yield* subscriptions.registerPwa({ payload: registration });
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            const effect = subscriptions
              .removePwaPublic({ ...installation, subscriptionId: registered.subscriptionId })
              .pipe(
                Effect.provideService(Limits.PublicRelayRateLimits, {
                  admit: () =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                    ),
                }),
              );
            const fiber = yield* effect.pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* subscriptions.registerPwa({
              payload: { ...registration, keys: { ...registration.keys, auth: "rotated" } },
            });
            yield* subscriptions.transitionEnvironment({ environmentId: "env", state });
            const before = yield* db.select().from(relayWebPushSubscriptionStates);
            yield* Deferred.succeed(resume, undefined);
            expect(yield* Fiber.join(fiber)).toBe(false);
            expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual(before);
          }),
        ).pipe(Effect.scoped),
    );
    it.effect.each(["updateLinkPreferences", "wakeHeldHooks", "publishAgentActivity"] as const)(
      "%s real ownership snapshot cannot expand during admission",
      (operation) =>
        withPg(
          Effect.gen(function* () {
            const db = yield* Db.RelayDb;
            const links = yield* Links.EnvironmentLinks;
            const c = counters();
            yield* insertLink(db, "user_managed", { managed: true });
            yield* insertLink(db, "user_publishonly");
            yield* insertLink(db, "user_wrongkey", { key: "other-key" });
            const entered = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            const admitted: string[] = [];
            const endpoint = yield* fixture({
              counts: c,
              links,
              admit: (_, subject) =>
                Effect.gen(function* () {
                  if (subject.kind !== "user") return;
                  admitted.push(subject.userId);
                  if (admitted.length === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(resume);
                  }
                }),
            });
            const fiber = yield* send(endpoint, yield* requestForOperation(operation)).pipe(
              Effect.forkChild,
            );
            yield* Deferred.await(entered);
            yield* insertLink(db, "user_ungated", { managed: true });
            yield* Deferred.succeed(resume, undefined);
            expect((yield* Fiber.join(fiber)).status).toBe(200);
            expect(new Set(admitted)).toEqual(
              new Set(
                operation === "wakeHeldHooks"
                  ? ["user_managed"]
                  : ["user_managed", "user_publishonly"],
              ),
            );
            if (operation === "updateLinkPreferences") {
              const records = yield* db.select().from(relayEnvironmentLinks);
              expect(
                records
                  .filter((row) => !row.holdWebhooksWhileOffline)
                  .map((row) => row.userId)
                  .sort(),
              ).toEqual(["user_managed", "user_publishonly"]);
            }
            if (operation === "wakeHeldHooks") expect(c.allocationOwners).toEqual(["user_managed"]);
            if (operation === "publishAgentActivity")
              expect(new Set(c.recipients)).toEqual(new Set(admitted));
          }),
        ).pipe(Effect.scoped),
    );
    it.effect(
      "preference current-key and incarnation predicates skip revoked and recreated same-ID links",
      () =>
        withPg(
          Effect.gen(function* () {
            const db = yield* Db.RelayDb;
            const links = yield* Links.EnvironmentLinks;
            yield* insertLink(db, "user_recreated", { managed: true });
            yield* insertLink(db, "user_revoked");
            yield* insertLink(db, "user_current");
            yield* insertLink(db, "user_wrongkey", { key: "other-key" });
            const snapshot = yield* links.listActiveForEnvironment({
              environmentId: "env",
              environmentPublicKey: relayKeys.publicKey,
            });
            yield* db
              .delete(relayEnvironmentLinks)
              .where(eq(relayEnvironmentLinks.userId, "user_recreated"));
            yield* insertLink(db, "user_recreated", { managed: true });
            yield* db
              .update(relayEnvironmentLinks)
              .set({ revokedAt: "1970-01-01T00:01:00.000Z" })
              .where(eq(relayEnvironmentLinks.userId, "user_revoked"));
            const affected = yield* links.setHoldWebhooksWhileOfflineForLinks({
              environmentId: "env",
              environmentPublicKey: relayKeys.publicKey,
              holdWebhooksWhileOffline: false,
              links: snapshot,
            });
            expect(affected.map((row) => row.userId)).toEqual(["user_current"]);
            const changed = yield* db
              .select()
              .from(relayEnvironmentLinks)
              .where(eq(relayEnvironmentLinks.holdWebhooksWhileOffline, false));
            expect(changed.map((row) => row.userId)).toEqual(["user_current"]);
          }),
        ).pipe(Effect.scoped),
    );
  },
);

describe.runIf(fixtureFile !== undefined)("real PostgreSQL recovery selector authority", () => {
  it.effect.each(["revoked", "selector-mismatch", "matching-multiple-owners"] as const)(
    "recovery real %s row authority never credits an unproven owner",
    (kind) =>
      withPg(
        Effect.gen(function* () {
          const db = yield* Db.RelayDb;
          const links = yield* Links.EnvironmentLinks;
          const c = counters();
          yield* insertLink(db, "user_other", { managed: true });
          yield* insertLink(db, "user_verified", { managed: true });
          if (kind === "revoked")
            yield* db
              .update(relayEnvironmentLinks)
              .set({ revokedAt: "1970-01-01T00:01:00.000Z" })
              .where(eq(relayEnvironmentLinks.userId, "user_verified"));
          const credited: string[] = [];
          const endpoint = yield* fixture({
            counts: c,
            links,
            admit: (_, subject) =>
              Effect.sync(() => {
                if (subject.kind === "user") credited.push(subject.userId);
              }),
          });
          let request = yield* requestForOperation("recoverManagedEndpoint");
          if (kind === "selector-mismatch") {
            const payload = yield* decodeRecovery(yield* Effect.promise(() => request.text()));
            request = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: yield* encodePayloadJson({ ...payload, cloudUserId: "user_other" }),
            });
          }
          expect((yield* send(endpoint, request)).status).toBe(
            kind === "matching-multiple-owners" ? 200 : 401,
          );
          expect(credited).toEqual(kind === "matching-multiple-owners" ? ["user_verified"] : []);
          expect(c.provider).toBe(kind === "matching-multiple-owners" ? 1 : 0);
        }),
      ).pipe(Effect.scoped),
  );
});

describe.runIf(fixtureFile !== undefined)("public first-create admission race", () => {
  it.effect.each(["deny", "outage"] as const)(
    "%s rejects an empty-preflight request that loses its installation before transaction work",
    (mode) =>
      withPg(
        Effect.gen(function* () {
          const db = yield* Db.RelayDb;
          const crypto = yield* Crypto.Crypto;
          const entered = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          type Phase = "preflight" | "winner" | "delayed" | "retry";
          const count = () => ({
            hash: 0,
            select: 0,
            uuid: 0,
            locks: 0,
            insert: 0,
            upsert: 0,
            delete: 0,
            update: 0,
          });
          const queries = { preflight: count(), winner: count(), delayed: count(), retry: count() };
          let phase: Phase = "preflight";
          let uuidCalls = 0;
          const loggedDb = yield* PgDrizzle.make().pipe(
            Effect.provideService(PgClient.PgClient, db.$client),
            Effect.provideService(EffectLogger, {
              logQuery: (query) =>
                Effect.sync(() => {
                  const sql = query.trim().toLowerCase();
                  // Classify statements only. SQL parameters and credential values are never recorded.
                  const kind = sql.includes("pg_advisory_xact_lock")
                    ? "locks"
                    : sql.startsWith("select")
                      ? "select"
                      : sql.startsWith("insert")
                        ? sql.includes("do update")
                          ? "upsert"
                          : "insert"
                        : sql.startsWith("delete")
                          ? "delete"
                          : "update";
                  queries[phase][kind]++;
                }),
            }),
            Effect.provide(PgDrizzle.DefaultServices),
          );
          const service = yield* Subscriptions.make.pipe(
            Effect.provideService(Db.RelayDb, loggedDb),
            Effect.provideService(Configuration.RelayConfiguration, legacyConfig),
            Effect.provideService(Crypto.Crypto, {
              ...crypto,
              digest: (...args) =>
                crypto
                  .digest(...args)
                  .pipe(Effect.tap(() => Effect.sync(() => queries[phase].hash++))),
              randomUUIDv4: ((options?: Parameters<Crypto.Crypto["randomUUIDv4"]>[0]) =>
                Effect.gen(function* () {
                  queries[phase].uuid++;
                  if (++uuidCalls === 1) {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(resume);
                  }
                  return yield* crypto.randomUUIDv4(options);
                })) as Crypto.Crypto["randomUUIDv4"],
            }),
          );
          const ownershipFailures: unknown[] = [];
          const subscriptions: Subscriptions.WebPushSubscriptions["Service"] = {
            ...service,
            registerPwaPublic: (input) =>
              service.registerPwaPublic(input).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    if (error._tag === "WebPushSubscriptionPersistenceError")
                      ownershipFailures.push(error.cause);
                  }),
                ),
              ),
          };
          const admitted: Limits.PublicRelaySubject[] = [];
          const endpoint = yield* fixture({
            counts: counters(),
            config: legacyConfig,
            subscriptions,
            admit: (_, subject) => {
              admitted.push(subject);
              return subject.kind === "installation" ? limited(mode) : Effect.void;
            },
          });
          const delayedPayload = {
            ...registration,
            endpoint: "https://push.example.test/delayed-replacement",
            keys: { p256dh: "delayed-key", auth: "delayed-auth" },
          };
          const delayed = yield* send(
            endpoint,
            yield* requestForOperation("registerPwaWebPushSubscription", {
              payload: delayedPayload,
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          expect(queries.preflight).toEqual({
            hash: 1,
            select: 1,
            uuid: 1,
            locks: 0,
            insert: 0,
            upsert: 0,
            delete: 0,
            update: 0,
          });
          expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual([]);
          phase = "winner";
          const winner = yield* send(
            endpoint,
            yield* requestForOperation("registerPwaWebPushSubscription", { payload: registration }),
          );
          expect(winner.status).toBe(200);
          const reference = yield* makeSubscriptions(legacyConfig, counters());
          yield* reference.transitionEnvironment({ environmentId: "env", state });
          const beforeRows = yield* db.select().from(relayWebPushSubscriptions);
          const beforeStates = yield* db.select().from(relayWebPushSubscriptionStates);
          expect(beforeRows).toHaveLength(1);
          expect(beforeStates).toHaveLength(1);
          expect(admitted).toEqual([
            { kind: "edge", ip: "192.0.2.4" },
            { kind: "edge", ip: "192.0.2.4" },
          ]);
          phase = "delayed";
          yield* Deferred.succeed(resume, undefined);
          const rejected = yield* Fiber.join(delayed);
          expect(rejected.status).toBe(500);
          expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
            code: "internal_error",
            reason: "internal_error",
          });
          expect(ownershipFailures).toHaveLength(1);
          expect(ownershipFailures[0]).toMatchObject({ cause: "installation_ownership_changed" });
          expect(queries.delayed).toEqual({
            hash: 0,
            select: 1,
            uuid: 0,
            locks: 2,
            insert: 1,
            upsert: 0,
            delete: 0,
            update: 0,
          });
          expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual(beforeRows);
          expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual(beforeStates);
          phase = "retry";
          const retry = yield* send(
            endpoint,
            yield* requestForOperation("registerPwaWebPushSubscription", {
              payload: delayedPayload,
            }),
          );
          expect(retry.status).toBe(mode === "deny" ? 429 : 503);
          expect(queries.retry).toEqual({
            hash: 1,
            select: 1,
            uuid: 0,
            locks: 0,
            insert: 0,
            upsert: 0,
            delete: 0,
            update: 0,
          });
          expect(admitted.slice(2)).toEqual([
            { kind: "edge", ip: "192.0.2.4" },
            { kind: "installation", installationId: installation.installationId },
          ]);
          expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual(beforeRows);
          expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual(beforeStates);
        }),
      ).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped),
  );
  it.effect(
    "public first-create, admitted renewal and endpoint transfer retain their normal ownership behavior",
    () =>
      withPg(
        Effect.gen(function* () {
          const db = yield* Db.RelayDb;
          const subscriptions = yield* makeSubscriptions(legacyConfig, counters());
          const admitted: Limits.PublicRelaySubject[] = [];
          const endpoint = yield* fixture({
            counts: counters(),
            config: legacyConfig,
            subscriptions,
            admit: (_, subject) =>
              Effect.sync(() => {
                admitted.push(subject);
              }),
          });
          expect(
            (yield* send(
              endpoint,
              yield* requestForOperation("registerPwaWebPushSubscription", {
                payload: registration,
              }),
            )).status,
          ).toBe(200);
          const [created] = yield* db.select().from(relayWebPushSubscriptions);
          expect(created).toBeDefined();
          yield* subscriptions.transitionEnvironment({ environmentId: "env", state });
          expect(
            (yield* send(
              endpoint,
              yield* requestForOperation("registerPwaWebPushSubscription", {
                payload: registration,
              }),
            )).status,
          ).toBe(200);
          expect(yield* db.select().from(relayWebPushSubscriptions)).toEqual([created]);
          expect(yield* db.select().from(relayWebPushSubscriptionStates)).toHaveLength(1);
          const transferred = {
            ...registration,
            installation: {
              installationId: "installation-transfer",
              installationSecret: "transfer-secret",
            },
          };
          expect(
            (yield* send(
              endpoint,
              yield* requestForOperation("registerPwaWebPushSubscription", {
                payload: transferred,
              }),
            )).status,
          ).toBe(200);
          const [current] = yield* db.select().from(relayWebPushSubscriptions);
          expect(current?.installationId).toBe("installation-transfer");
          expect(current?.incarnationId).not.toBe(created?.incarnationId);
          expect(yield* db.select().from(relayWebPushSubscriptionStates)).toEqual([]);
          expect(admitted.map((subject) => subject.kind)).toEqual([
            "edge",
            "edge",
            "installation",
            "edge",
          ]);
        }),
      ).pipe(Effect.scoped),
  );
});
