import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import type { RelayEnvironmentLinkProofPayload } from "@t3tools/contracts/relay";
import { sql } from "drizzle-orm";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import webpush from "web-push";
import { vi } from "vite-plus/test";
import { RelayConfiguration } from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import {
  relayAgentActivityRows,
  relayEnvironmentLinks,
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
  relayDeliveryAttempts,
} from "../persistence/schema.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as AgentActivityPublisher from "./AgentActivityPublisher.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import * as WebPushDeliveryQueue from "./WebPushDeliveryQueue.ts";
import * as WebPushDeliveries from "./WebPushDeliveries.ts";
import * as LiveActivities from "./LiveActivities.ts";
import * as ApnsDeliveries from "./ApnsDeliveries.ts";
import * as FcmDeliveries from "./FcmDeliveries.ts";
import { fixtureFile, layerDb } from "./incarnationPostgresFixture.ts";
import {
  signWebPushDeliveryJob,
  type SignedWebPushDeliveryJob,
  type WebPushDeliveryPayload,
  type WebPushJobCryptoError,
} from "./webPushDeliveryJobs.ts";
import { config, state, registration } from "./webPushConsumer.test-fixture.ts";

vi.mock("web-push", () => ({
  default: { sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })) },
}));
const webCrypto = { subtle: globalThis.crypto.subtle };
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
  environmentId: state.environmentId,
  environmentPublicKey: "key-A",
  endpoint,
  origin: { localHttpHost: "localhost", localHttpPort: 3000 },
  scopes: ["agent_activity_notifications"],
  descriptor: {
    environmentId: state.environmentId,
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
    managedTunnelsEnabled: false,
  },
};
type Fixture = {
  db: RelayDb.RelayDb["Service"];
  rows: AgentActivityRows.AgentActivityRows["Service"];
  links: EnvironmentLinks.EnvironmentLinks["Service"];
  subscriptions: WebPushSubscriptions.WebPushSubscriptions["Service"];
  legacySubscriptions: WebPushSubscriptions.WebPushSubscriptions["Service"];
  legacyDeliveries: WebPushDeliveries.WebPushDeliveries["Service"];
  deliveries: WebPushDeliveries.WebPushDeliveries["Service"];
  queue: WebPushDeliveryQueue.WebPushDeliveryQueue["Service"];
  publisher: AgentActivityPublisher.AgentActivityPublisher["Service"];
  jobs: SignedWebPushDeliveryJob[];
  lifecycle: { claims: number; completes: number; releases: number; records: number };
  sign: (
    payload: WebPushDeliveryPayload,
  ) => Effect.Effect<SignedWebPushDeliveryJob, Schema.SchemaError | WebPushJobCryptoError>;
};
// Bridge the counted Promise-based transport adapter without starting an Effect runtime.
function barrier() {
  let signal: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!signal) throw new Error("Uninitialized fixture barrier");
      signal();
    },
  };
}
function fixture<A, E>(run: (f: Fixture) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const rows = yield* AgentActivityRows.make;
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const subscriptions = yield* WebPushSubscriptions.make;
    const legacyConfiguration: RelayConfiguration["Service"] = {
      ...config,
      clerkAuthPolicy: { mode: "legacy" },
    };
    const legacySubscriptions = yield* WebPushSubscriptions.make.pipe(
      Effect.provideService(RelayConfiguration, legacyConfiguration),
    );
    const realAttempts = yield* DeliveryAttempts.make;
    const lifecycle = { claims: 0, completes: 0, releases: 0, records: 0 };
    const attempts = DeliveryAttempts.DeliveryAttempts.of({
      ...realAttempts,
      claimSourceJob: (input) =>
        Effect.suspend(() => {
          lifecycle.claims++;
          return realAttempts.claimSourceJob(input);
        }),
      completeSourceJob: (input) =>
        Effect.suspend(() => {
          lifecycle.completes++;
          return realAttempts.completeSourceJob(input);
        }),
      releaseSourceJob: (input) =>
        Effect.suspend(() => {
          lifecycle.releases++;
          const release = realAttempts.releaseSourceJob;
          return release ? release(input) : Effect.die("Fixture lacks production release");
        }),
      record: (input) =>
        Effect.suspend(() => {
          lifecycle.records++;
          return realAttempts.record(input);
        }),
    });
    const jobs: SignedWebPushDeliveryJob[] = [];
    const queue = yield* WebPushDeliveryQueue.make.pipe(
      Effect.provideService(WebPushDeliveryQueue.WebPushDeliveryQueueSender, {
        send: (job) =>
          Effect.sync(() => {
            jobs.push(job);
          }),
      }),
    );
    const deliveries = yield* WebPushDeliveries.make.pipe(
      Effect.provideService(AgentActivityRows.AgentActivityRows, rows),
      Effect.provideService(WebPushSubscriptions.WebPushSubscriptions, subscriptions),
      Effect.provideService(DeliveryAttempts.DeliveryAttempts, attempts),
    );
    const legacyDeliveries = yield* WebPushDeliveries.make.pipe(
      Effect.provideService(RelayConfiguration, legacyConfiguration),
      Effect.provideService(AgentActivityRows.AgentActivityRows, rows),
      Effect.provideService(WebPushSubscriptions.WebPushSubscriptions, legacySubscriptions),
      Effect.provideService(DeliveryAttempts.DeliveryAttempts, attempts),
    );
    const liveActivities = yield* LiveActivities.make;
    const publisher = yield* AgentActivityPublisher.make.pipe(
      Effect.provideService(AgentActivityRows.AgentActivityRows, rows),
      Effect.provideService(EnvironmentLinks.EnvironmentLinks, links),
      Effect.provideService(WebPushSubscriptions.WebPushSubscriptions, subscriptions),
      Effect.provideService(WebPushDeliveryQueue.WebPushDeliveryQueue, queue),
      Effect.provideService(LiveActivities.LiveActivities, liveActivities),
      Effect.provide(
        Layer.merge(
          Layer.mock(ApnsDeliveries.ApnsDeliveries, {}),
          Layer.mock(FcmDeliveries.FcmDeliveries, {}),
        ),
      ),
    );
    vi.mocked(webpush.sendNotification).mockClear();
    vi.mocked(webpush.sendNotification).mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });
    return yield* run({
      db,
      rows,
      links,
      subscriptions,
      legacySubscriptions,
      legacyDeliveries,
      deliveries,
      queue,
      publisher,
      jobs,
      lifecycle,
      sign: (payload) =>
        signWebPushDeliveryJob({ secret: config.apnsDeliveryJobSigningSecret, payload }).pipe(
          Effect.provideService(WebCrypto.WebCrypto, webCrypto),
        ),
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        EnvironmentLinks.layer.pipe(Layer.provideMerge(layerDb)),
        NodeCrypto.layer,
        Layer.succeed(RelayConfiguration, config),
        Layer.succeed(WebCrypto.WebCrypto, webCrypto),
      ),
    ),
  );
}
function seeded(f: Fixture) {
  return Effect.gen(function* () {
    yield* f.links.upsert(linkInput);
    const registrationResult = yield* f.subscriptions.register({
      userId: linkInput.userId,
      payload: registration,
    });
    yield* f.rows.upsert({ environmentPublicKey: proof.environmentPublicKey, state });
    const [link] = yield* f.db.select().from(relayEnvironmentLinks);
    const subscription = yield* f.subscriptions.get({
      userId: linkInput.userId,
      subscriptionId: registrationResult.subscriptionId,
    });
    if (!link || !subscription) throw new Error("Fixture authority missing");
    const payload: WebPushDeliveryPayload = {
      version: 2,
      kind: "activity",
      jobId: "fixture-job",
      userId: subscription.userId,
      subscriptionId: subscription.id,
      subscriptionIncarnationId: subscription.incarnationId,
      eventId: "opaque:test-looking",
      showProjectAndThreadNames: true,
      createdAt: state.updatedAt,
      expiresAt: "1970-01-01T00:10:00.000Z",
      provenance: {
        environmentId: state.environmentId,
        environmentPublicKey: proof.environmentPublicKey,
        threadId: state.threadId,
        linkIncarnationId: link.incarnationId,
        notificationKind: "input_required",
        stateVersion: {
          updatedAt: state.updatedAt,
          phase: state.phase,
          hasActionableProposedPlan: false,
        },
      },
    };
    return { link, subscription, payload, job: yield* f.sign(payload) };
  });
}
const serial = (job: SignedWebPushDeliveryJob): unknown => JSON.parse(JSON.stringify(job));
const none = (f: Fixture) => {
  expect(f.lifecycle).toEqual({ claims: 0, completes: 0, releases: 0, records: 0 });
  expect(webpush.sendNotification).not.toHaveBeenCalled();
};

describe.runIf(fixtureFile !== undefined)(
  "real PostgreSQL current Web Push authority (explicit fixture)",
  () => {
    it.effect(
      "publishes notifications-only activity through real selection/queue/HMAC/consumer/current copy and one record",
      () =>
        fixture((f) =>
          Effect.gen(function* () {
            yield* f.links.upsert(linkInput);
            yield* f.subscriptions.register({ userId: linkInput.userId, payload: registration });
            const publish = (activityState: typeof state) =>
              f.publisher.publish({
                environmentId: state.environmentId,
                environmentPublicKey: proof.environmentPublicKey,
                threadId: state.threadId,
                state: activityState,
              });
            yield* publish({ ...state, phase: "running" });
            expect(f.jobs).toEqual([]);
            yield* TestClock.setTime(1000);
            const next = { ...state, updatedAt: "1970-01-01T00:00:01.000Z" };
            expect((yield* publish(next)).deliveries).toHaveLength(1);
            expect(f.jobs).toHaveLength(1);
            const job = f.jobs[0];
            if (!job) throw new Error("No produced job");
            yield* f.rows.upsert({
              environmentPublicKey: proof.environmentPublicKey,
              state: {
                ...next,
                headline: "Changed after queue",
                threadTitle: "Fresh Thread",
                projectTitle: "Fresh Project",
                deepLink: "/fresh",
              },
            });
            expect((yield* f.deliveries.processSignedJob(serial(job))).ok).toBe(true);
            expect(
              JSON.parse(String(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1])),
            ).toMatchObject({
              title: "Fresh Thread",
              body: "Changed after queue · Fresh Project",
              deepLink: "/fresh",
            });
            expect((yield* f.deliveries.processSignedJob(serial(job))).webPushReason).toBe(
              "duplicate_job",
            );
            expect(webpush.sendNotification).toHaveBeenCalledOnce();
            expect(yield* f.db.select().from(relayDeliveryAttempts)).toHaveLength(1);
            expect(f.lifecycle).toEqual({ claims: 2, completes: 1, releases: 0, records: 0 });
            yield* f.links.revokeForUser({
              userId: linkInput.userId,
              environmentId: state.environmentId,
            });
            expect((yield* f.deliveries.processSignedJob(serial(job))).ok).toBe(false);
            expect(f.lifecycle.claims).toBe(2);
          }),
        ),
    );
    it.effect(
      "allows separate account links sharing the exact key while rejecting other accounts/keys/ids/UUIDs",
      () =>
        fixture((f) =>
          Effect.gen(function* () {
            const seed = yield* seeded(f);
            yield* f.links.upsert({ ...linkInput, userId: "account-B" });
            const links = yield* f.db.select().from(relayEnvironmentLinks);
            for (const link of links)
              expect(
                yield* f.rows.getForNotification({
                  userId: link.userId,
                  environmentId: state.environmentId,
                  environmentPublicKey: proof.environmentPublicKey,
                  threadId: state.threadId,
                  linkIncarnationId: link.incarnationId,
                }),
              ).toEqual(state);
            for (const changed of [
              { userId: "another" },
              { environmentPublicKey: "key-B" },
              { environmentId: "another" },
              { threadId: "another" },
              { linkIncarnationId: "00000000-0000-4000-8000-000000000002" },
            ])
              expect(
                yield* f.rows.getForNotification({
                  userId: linkInput.userId,
                  environmentId: state.environmentId,
                  environmentPublicKey: proof.environmentPublicKey,
                  threadId: state.threadId,
                  linkIncarnationId: seed.link.incarnationId,
                  ...changed,
                }),
              ).toBeNull();
            const registered = yield* f.subscriptions.register({
              userId: "account-B",
              payload: { ...registration, endpoint: `${registration.endpoint}/B` },
            });
            const sub = yield* f.subscriptions.get({
              userId: "account-B",
              subscriptionId: registered.subscriptionId,
            });
            const link = links.find((row) => row.userId === "account-B");
            if (!sub || !link) throw new Error("Second account missing");
            const second: WebPushDeliveryPayload = {
              ...seed.payload,
              jobId: "second",
              userId: "account-B",
              subscriptionId: sub.id,
              subscriptionIncarnationId: sub.incarnationId,
              provenance: { ...seed.payload.provenance, linkIncarnationId: link.incarnationId },
            };
            expect((yield* f.deliveries.processSignedJob(serial(seed.job))).ok).toBe(true);
            expect((yield* f.deliveries.processSignedJob(serial(yield* f.sign(second)))).ok).toBe(
              true,
            );
            expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
            expect(
              yield* f.subscriptions.get({
                userId: "account-B",
                subscriptionId: seed.subscription.id,
              }),
            ).toBeNull();
            expect(
              yield* f.subscriptions.get({ userId: linkInput.userId, subscriptionId: "another" }),
            ).toBeNull();
          }),
        ),
    );
    it.effect.each([
      "delete",
      "invalid_json",
      "decoded_environment",
      "decoded_thread",
      "updated_at",
      "phase",
      "plan",
      "new_version",
      "revoked",
      "relinked",
      "key_A_B_A",
      "managed",
      "notifications_off",
      "wrong_key",
      "wrong_environment",
      "wrong_thread",
      "wrong_link",
    ])("denies %s without any delivery lifecycle or audit row", (change) =>
      fixture((f) =>
        Effect.gen(function* () {
          const seed = yield* seeded(f);
          let payload = seed.payload;
          if (change === "delete")
            yield* f.rows.remove({
              environmentId: state.environmentId,
              environmentPublicKey: proof.environmentPublicKey,
              threadId: state.threadId,
            });
          if (change === "invalid_json")
            yield* f.db.update(relayAgentActivityRows).set({ stateJson: sql`'{}'::jsonb` });
          if (change === "decoded_environment")
            yield* f.db.update(relayAgentActivityRows).set({
              stateJson: sql`jsonb_set(state_json, '{environmentId}', '"another"'::jsonb)`,
            });
          if (change === "decoded_thread")
            yield* f.db
              .update(relayAgentActivityRows)
              .set({ stateJson: sql`jsonb_set(state_json, '{threadId}', '"another"'::jsonb)` });
          if (change === "updated_at")
            yield* f.db
              .update(relayAgentActivityRows)
              .set({ updatedAt: "1970-01-01T00:00:01.000Z" });
          if (change === "phase")
            yield* f.rows.upsert({
              environmentPublicKey: proof.environmentPublicKey,
              state: { ...state, phase: "running" },
            });
          if (change === "plan")
            yield* f.rows.upsert({
              environmentPublicKey: proof.environmentPublicKey,
              state: { ...state, hasActionableProposedPlan: true },
            });
          if (change === "new_version")
            yield* f.rows.upsert({
              environmentPublicKey: proof.environmentPublicKey,
              state: { ...state, updatedAt: "1970-01-01T00:00:01.000Z" },
            });
          if (change === "revoked" || change === "relinked")
            yield* f.links.revokeForUser({
              userId: linkInput.userId,
              environmentId: state.environmentId,
            });
          if (change === "relinked") yield* f.links.upsert(linkInput);
          if (change === "key_A_B_A") {
            yield* f.links.upsert({
              ...linkInput,
              proof: { ...proof, environmentPublicKey: "key-B" },
            });
            yield* f.links.upsert(linkInput);
          }
          if (change === "managed")
            yield* f.links.upsert({
              ...linkInput,
              request: { ...linkInput.request, managedTunnelsEnabled: true },
            });
          if (change === "notifications_off")
            yield* f.links.upsert({
              ...linkInput,
              request: { ...linkInput.request, notificationsEnabled: false },
            });
          if (change === "wrong_key")
            payload = {
              ...payload,
              provenance: { ...payload.provenance, environmentPublicKey: "key-B" },
            };
          if (change === "wrong_environment")
            payload = {
              ...payload,
              provenance: { ...payload.provenance, environmentId: "another" },
            };
          if (change === "wrong_thread")
            payload = { ...payload, provenance: { ...payload.provenance, threadId: "another" } };
          if (change === "wrong_link")
            payload = {
              ...payload,
              provenance: {
                ...payload.provenance,
                linkIncarnationId: "00000000-0000-4000-8000-000000000002",
              },
            };
          expect(
            (yield* f.deliveries.processSignedJob(serial(yield* f.sign(payload)))).webPushReason,
          ).toBe("activity_unavailable");
          none(f);
          expect(yield* f.db.select().from(relayDeliveryAttempts)).toEqual([]);
        }),
      ),
    );
    it.effect.each([
      "credentials",
      "owner_A_B_A",
      "remove_recreate",
      "preferences",
      "malformed_preferences",
    ])("honors reviewed subscription mutation %s", (change) =>
      fixture((f) =>
        Effect.gen(function* () {
          const seed = yield* seeded(f);
          if (change === "credentials")
            yield* f.subscriptions.register({
              userId: linkInput.userId,
              payload: { ...registration, keys: { p256dh: "new-key", auth: "new-auth" } },
            });
          if (change === "owner_A_B_A") {
            yield* f.subscriptions.register({ userId: "account-B", payload: registration });
            yield* f.subscriptions.register({ userId: linkInput.userId, payload: registration });
          }
          if (change === "remove_recreate") {
            yield* f.subscriptions.remove({
              userId: linkInput.userId,
              subscriptionId: seed.subscription.id,
            });
            yield* f.subscriptions.register({ userId: linkInput.userId, payload: registration });
          }
          if (change === "preferences")
            yield* f.subscriptions.register({
              userId: linkInput.userId,
              payload: {
                ...registration,
                preferences: {
                  ...registration.preferences,
                  enabled: false,
                  showProjectAndThreadNames: false,
                },
              },
            });
          if (change === "malformed_preferences")
            yield* f.db
              .update(relayWebPushSubscriptions)
              .set({ preferencesJson: sql`'{}'::jsonb` });
          expect((yield* f.deliveries.processSignedJob(serial(seed.job))).ok).toBe(false);
          none(f);
          if (change === "preferences" || change === "malformed_preferences") {
            const current = yield* f.subscriptions.get({
              userId: linkInput.userId,
              subscriptionId: seed.subscription.id,
            });
            expect(current?.incarnationId).toBe(seed.subscription.incarnationId);
            expect(
              (yield* f.queue.enqueue({
                kind: "test",
                userId: seed.subscription.userId,
                subscriptionId: seed.subscription.id,
                subscriptionIncarnationId: seed.subscription.incarnationId,
              })).queued,
            ).toBe(true);
            const job = f.jobs[0];
            if (!job) throw new Error("Missing test job");
            expect((yield* f.deliveries.processSignedJob(serial(job))).ok).toBe(true);
          }
        }),
      ),
    );
    it.effect.each(
      ([404, 410] as const).flatMap((status) =>
        (["credentials", "owner_A_B_A", "remove_recreate"] as const).flatMap((mutation) =>
          (["replacement_first", "cleanup_first"] as const).map((order) => ({
            status,
            mutation,
            order,
          })),
        ),
      ),
    )("binds real %j transport cleanup to its observed UUID", ({ status, mutation, order }) =>
      fixture((f) =>
        Effect.scoped(
          Effect.gen(function* () {
            const seed = yield* seeded(f);
            yield* f.subscriptions.transition({ userId: linkInput.userId, state });
            const sent = barrier();
            const finish = barrier();
            vi.mocked(webpush.sendNotification).mockImplementation(async () => {
              sent.resolve();
              await finish.promise;
              throw { statusCode: status };
            });
            const consumer = yield* Effect.forkChild(
              f.deliveries.processSignedJob(serial(seed.job)),
            );
            yield* Effect.promise(() => sent.promise);
            const replace = Effect.gen(function* () {
              if (mutation === "owner_A_B_A")
                yield* f.subscriptions.register({ userId: "account-B", payload: registration });
              if (mutation === "remove_recreate")
                yield* f.subscriptions.remove({
                  userId: linkInput.userId,
                  subscriptionId: seed.subscription.id,
                });
              yield* f.subscriptions.register({
                userId: linkInput.userId,
                payload:
                  mutation === "credentials"
                    ? { ...registration, keys: { p256dh: "new-key", auth: "new-auth" } }
                    : registration,
              });
              yield* f.subscriptions.transition({
                userId: linkInput.userId,
                state: { ...state, updatedAt: "1970-01-01T00:00:01.000Z" },
              });
            });
            if (order === "replacement_first") yield* replace;
            finish.resolve();
            expect(yield* Fiber.join(consumer)).toMatchObject({
              ok: false,
              webPushStatus: status,
              webPushReason: "subscription_gone",
            });
            if (order === "cleanup_first") yield* replace;
            const [current] = yield* f.db.select().from(relayWebPushSubscriptions);
            if (!current) throw new Error("Replacement disappeared");
            expect(current.incarnationId).not.toBe(seed.subscription.incarnationId);
            expect(yield* f.db.select().from(relayWebPushSubscriptionStates)).toMatchObject([
              { subscriptionId: current.id, updatedAt: "1970-01-01T00:00:01.000Z" },
            ]);
            expect(f.lifecycle).toEqual({ claims: 1, completes: 1, releases: 0, records: 0 });
            expect(yield* f.db.select().from(relayDeliveryAttempts)).toMatchObject([
              { apnsStatus: status, apnsReason: "subscription_gone" },
            ]);
            expect(webpush.sendNotification).toHaveBeenCalledOnce();
          }),
        ),
      ),
    );
    it.effect(
      "invalidates anonymous-to-account conversion and uses only the fresh account row",
      () =>
        fixture((f) =>
          Effect.gen(function* () {
            const installation = {
              installationId: "installation-A",
              installationSecret: "fixture-secret",
            };
            const registered = yield* f.legacySubscriptions.registerPwa({
              payload: { ...registration, installation, environmentId: state.environmentId },
            });
            const old = yield* f.legacySubscriptions.get({
              userId: "pwa:installation-A",
              subscriptionId: registered.subscriptionId,
            });
            if (!old) throw new Error("Anonymous row missing");
            const job = yield* f.sign({
              version: 2,
              kind: "test",
              jobId: "anonymous-job",
              userId: old.userId,
              subscriptionId: old.id,
              subscriptionIncarnationId: old.incarnationId,
              createdAt: state.updatedAt,
              expiresAt: "1970-01-01T00:10:00.000Z",
            });
            yield* f.subscriptions.register({ userId: linkInput.userId, payload: registration });
            expect((yield* f.legacyDeliveries.processSignedJob(serial(job))).ok).toBe(false);
            none(f);
            const fresh = yield* f.subscriptions.get({
              userId: linkInput.userId,
              subscriptionId: registered.subscriptionId,
            });
            if (!fresh) throw new Error("Converted row missing");
            expect(fresh.incarnationId).not.toBe(old.incarnationId);
            expect(fresh).toMatchObject({
              installationId: null,
              environmentId: null,
              installationSecretHash: null,
            });
            yield* f.queue.enqueue({
              kind: "test",
              userId: fresh.userId,
              subscriptionId: fresh.id,
              subscriptionIncarnationId: fresh.incarnationId,
            });
            const test = f.jobs[0];
            if (!test) throw new Error("Fresh job missing");
            expect((yield* f.deliveries.processSignedJob(serial(test))).ok).toBe(true);
          }),
        ),
    );
    it.effect.each([
      "environment",
      "installation",
      "hash",
      "pwa_without_installation",
      "wrong_installation",
      "bad_endpoint",
      "empty_key",
      "empty_auth",
    ])("rejects actual SQL ownership/target corruption %s for both V2 kinds", (change) =>
      fixture((f) =>
        Effect.gen(function* () {
          const seed = yield* seeded(f);
          if (change === "environment")
            yield* f.db.update(relayWebPushSubscriptions).set({ environmentId: "residual" });
          if (change === "installation")
            yield* f.db.update(relayWebPushSubscriptions).set({ installationId: "residual" });
          if (change === "hash")
            yield* f.db
              .update(relayWebPushSubscriptions)
              .set({ installationSecretHash: "residual" });
          if (change === "pwa_without_installation")
            yield* f.db.update(relayWebPushSubscriptions).set({ userId: "pwa:installation-A" });
          if (change === "wrong_installation")
            yield* f.db.update(relayWebPushSubscriptions).set({
              userId: "pwa:installation-A",
              environmentId: state.environmentId,
              installationId: "installation-B",
              installationSecretHash: "hash",
            });
          if (change === "bad_endpoint")
            yield* f.db.update(relayWebPushSubscriptions).set({ endpoint: "http://bad" });
          if (change === "empty_key")
            yield* f.db.update(relayWebPushSubscriptions).set({ p256dh: "" });
          if (change === "empty_auth")
            yield* f.db.update(relayWebPushSubscriptions).set({ auth: "" });
          const userId =
            change.startsWith("pwa_") || change === "wrong_installation"
              ? "pwa:installation-A"
              : seed.payload.userId;
          const activityPayload = userId.startsWith("pwa:")
            ? {
                ...seed.payload,
                userId,
                provenance: { ...seed.payload.provenance, linkIncarnationId: null },
              }
            : seed.payload;
          const testPayload: WebPushDeliveryPayload = {
            version: 2,
            kind: "test",
            jobId: "test-corrupt",
            userId,
            subscriptionId: seed.subscription.id,
            subscriptionIncarnationId: seed.subscription.incarnationId,
            createdAt: state.updatedAt,
            expiresAt: "1970-01-01T00:10:00.000Z",
          };
          expect(
            (yield* f.legacyDeliveries.processSignedJob(serial(yield* f.sign(activityPayload)))).ok,
          ).toBe(false);
          expect(
            (yield* f.legacyDeliveries.processSignedJob(serial(yield* f.sign(testPayload)))).ok,
          ).toBe(false);
          none(f);
        }),
      ),
    );
    it.effect(
      "keeps exact notification lookup persistence failure typed instead of returning null",
      () =>
        fixture((f) =>
          Effect.gen(function* () {
            const seed = yield* seeded(f);
            yield* f.db.$client.unsafe(
              "ALTER TABLE relay_agent_activity_rows RENAME TO fixture_unavailable_rows",
            );
            expect(
              (yield* Effect.flip(
                f.rows.getForNotification({
                  userId: seed.subscription.userId,
                  environmentId: state.environmentId,
                  environmentPublicKey: proof.environmentPublicKey,
                  threadId: state.threadId,
                  linkIncarnationId: seed.link.incarnationId,
                }),
              ))._tag,
            ).toBe("AgentActivityRowListPersistenceError");
            expect((yield* Effect.flip(f.deliveries.processSignedJob(serial(seed.job))))._tag).toBe(
              "WebPushDeliveryTransportError",
            );
            none(f);
          }),
        ),
    );
    it.effect.each([
      [false, true],
      [true, false],
      [true, true],
    ] as const)(
      "rechecks actual preferences-only name changes %j without rotating UUID",
      ([queuedNames, currentNames]) =>
        fixture((f) =>
          Effect.gen(function* () {
            const seed = yield* seeded(f);
            const job = yield* f.sign({ ...seed.payload, showProjectAndThreadNames: queuedNames });
            yield* f.subscriptions.register({
              userId: linkInput.userId,
              payload: {
                ...registration,
                preferences: {
                  ...registration.preferences,
                  showProjectAndThreadNames: currentNames,
                },
              },
            });
            const fresh = yield* f.subscriptions.get({
              userId: linkInput.userId,
              subscriptionId: seed.subscription.id,
            });
            expect(fresh?.incarnationId).toBe(seed.subscription.incarnationId);
            expect((yield* f.deliveries.processSignedJob(serial(job))).ok).toBe(true);
            expect(
              JSON.parse(String(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1])),
            ).toMatchObject({
              title: queuedNames && currentNames ? state.threadTitle : "Arcwright Code",
              showProjectAndThreadNames: queuedNames && currentNames,
            });
          }),
        ),
    );
    it.effect(
      "uses a changed anonymous endpoint only for freshly bound jobs and never revalidates invisible source state",
      () =>
        fixture((f) =>
          Effect.gen(function* () {
            const installation = {
              installationId: "installation-A",
              installationSecret: "fixture-secret",
            };
            const payload = { ...registration, installation, environmentId: state.environmentId };
            const registered = yield* f.legacySubscriptions.registerPwa({ payload });
            const old = yield* f.legacySubscriptions.get({
              userId: "pwa:installation-A",
              subscriptionId: registered.subscriptionId,
            });
            if (!old) throw new Error("Anonymous row missing");
            const sourcePayload: WebPushDeliveryPayload = {
              version: 2,
              kind: "activity",
              jobId: "anonymous-activity",
              userId: old.userId,
              subscriptionId: old.id,
              subscriptionIncarnationId: old.incarnationId,
              eventId: "opaque-source-tag",
              showProjectAndThreadNames: true,
              createdAt: state.updatedAt,
              expiresAt: "1970-01-01T00:10:00.000Z",
              provenance: {
                environmentId: state.environmentId,
                environmentPublicKey: "unobservable-key",
                threadId: state.threadId,
                linkIncarnationId: null,
                notificationKind: "input_required",
                stateVersion: {
                  updatedAt: state.updatedAt,
                  phase: state.phase,
                  hasActionableProposedPlan: false,
                },
              },
            };
            const oldJob = yield* f.sign(sourcePayload);
            yield* f.legacySubscriptions.registerPwa({
              payload: { ...payload, endpoint: `${payload.endpoint}/new` },
            });
            expect((yield* f.legacyDeliveries.processSignedJob(serial(oldJob))).ok).toBe(false);
            none(f);
            const fresh = yield* f.legacySubscriptions.get({
              userId: old.userId,
              subscriptionId: old.id,
            });
            if (!fresh) throw new Error("Rotated row missing");
            expect(fresh.incarnationId).not.toBe(old.incarnationId);
            const freshJob = yield* f.sign({
              ...sourcePayload,
              jobId: "fresh-anonymous",
              subscriptionIncarnationId: fresh.incarnationId,
            });
            expect((yield* f.legacyDeliveries.processSignedJob(serial(freshJob))).ok).toBe(true);
            expect(vi.mocked(webpush.sendNotification).mock.calls[0]?.[0]).toEqual({
              endpoint: fresh.endpoint,
              keys: { p256dh: fresh.p256dh, auth: fresh.auth },
            });
            expect(
              JSON.parse(String(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1])),
            ).toEqual({
              eventId: "opaque-source-tag",
              title: "Arcwright Code",
              body: "An agent needs your attention.",
              deepLink: "/",
              showProjectAndThreadNames: false,
            });
            expect(yield* f.db.select().from(relayAgentActivityRows)).toEqual([]);
          }),
        ),
    );
  },
);
