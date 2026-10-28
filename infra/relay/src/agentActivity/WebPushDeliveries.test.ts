import { describe, expect, it } from "@effect/vitest";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import webpush from "web-push";
import { vi } from "vite-plus/test";
import { RelayConfiguration } from "../Config.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import * as WebPushDeliveries from "./WebPushDeliveries.ts";
import {
  signWebPushDeliveryJob,
  type WebPushActivityPayloadV2,
  type WebPushDeliveryPayload,
  type WebPushTestPayloadV2,
} from "./webPushDeliveryJobs.ts";
import { stateVersion } from "./webPushNotifications.ts";
import {
  config,
  subscription,
  state,
  linkIncarnationId,
  preferences,
} from "./webPushConsumer.test-fixture.ts";

vi.mock("web-push", () => ({
  default: { sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })) },
}));
const cryptoLayer = Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle });
const common = {
  version: 2,
  jobId: "job-A",
  userId: subscription.userId,
  subscriptionId: subscription.id,
  subscriptionIncarnationId: subscription.incarnationId,
  createdAt: state.updatedAt,
  expiresAt: "1970-01-01T00:10:00.000Z",
} satisfies Omit<WebPushTestPayloadV2, "kind">;
const activity: WebPushActivityPayloadV2 = {
  ...common,
  kind: "activity",
  eventId: "test-looking:opaque",
  showProjectAndThreadNames: true,
  provenance: {
    environmentId: state.environmentId,
    environmentPublicKey: "key-A",
    threadId: state.threadId,
    linkIncarnationId,
    notificationKind: "input_required",
    stateVersion: stateVersion(state),
  },
};
const testJob: WebPushTestPayloadV2 = { ...common, kind: "test" };

function harness(
  configuration: RelayConfiguration["Service"] = config,
  releaseAvailable = true,
  authorityClock?: {
    readonly clock: TestClock.TestClock;
    readonly accountReturnedAt: number | null;
    readonly subscriptionReturnedAt: number | null;
  },
) {
  const current: {
    subscription: typeof subscription;
    state: RelayAgentActivityState | null;
    fault: string;
    claim: string;
  } = {
    subscription: { ...subscription },
    state,
    fault: "",
    claim: "",
  };
  const calls: {
    gets: number;
    activities: number;
    claims: DeliveryAttempts.DeliveryAttemptInput[];
    completes: DeliveryAttempts.DeliveryAttemptCompletionInput[];
    releases: string[];
    removes: string[];
  } = {
    gets: 0,
    activities: 0,
    claims: [],
    completes: [],
    releases: [],
    removes: [],
  };
  const finished = new Set<string>();
  const transport = vi.mocked(webpush.sendNotification);
  transport.mockClear();
  transport.mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  const persistenceError = (
    operation: DeliveryAttempts.DeliveryAttemptRecordPersistenceError["operation"],
  ) =>
    new DeliveryAttempts.DeliveryAttemptRecordPersistenceError({
      operation,
      sourceJobId: common.jobId,
      userId: null,
      environmentId: null,
      threadId: null,
      deviceId: null,
      kind: null,
      cause: "fixture failure",
    });
  const deps = Layer.mergeAll(
    cryptoLayer,
    Layer.succeed(RelayConfiguration, configuration),
    Layer.mock(AgentActivityRows.AgentActivityRows, {
      getForNotification: (input) =>
        Effect.gen(function* () {
          calls.activities++;
          if (
            authorityClock?.accountReturnedAt !== undefined &&
            authorityClock.accountReturnedAt !== null
          )
            yield* authorityClock.clock.setTime(authorityClock.accountReturnedAt);
          if (current.fault === "activity")
            return yield* new AgentActivityRows.AgentActivityRowListPersistenceError({
              userId: input.userId,
              cause: "fixture failure",
            });
          return current.state;
        }),
    }),
    Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
      get: () =>
        Effect.gen(function* () {
          calls.gets++;
          if (
            authorityClock?.subscriptionReturnedAt !== undefined &&
            authorityClock.subscriptionReturnedAt !== null
          )
            yield* authorityClock.clock.setTime(authorityClock.subscriptionReturnedAt);
          if (current.fault === "lookup")
            return yield* new WebPushSubscriptions.WebPushSubscriptionPersistenceError({
              cause: "fixture failure",
            });
          return current.subscription;
        }),
      removeIfCurrent: (input) =>
        Effect.gen(function* () {
          calls.removes.push(input.subscriptionIncarnationId);
          if (current.fault === "cleanup")
            return yield* new WebPushSubscriptions.WebPushSubscriptionPersistenceError({
              cause: "fixture failure",
            });
          return false;
        }),
    }),
    Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
      record: () => Effect.die("Unexpected standalone Web Push audit record"),
      pruneExpired: Effect.succeed(0),
      claimSourceJob: (input) =>
        Effect.gen(function* () {
          calls.claims.push(input);
          if (current.fault === "claim") return yield* persistenceError("claim-source-job");
          if (current.claim === "in_flight") return "in_flight";
          return finished.has(input.sourceJobId) ? "completed" : "claimed";
        }),
      completeSourceJob: (input) =>
        Effect.gen(function* () {
          calls.completes.push(input);
          if (current.fault === "complete") return yield* persistenceError("complete-source-job");
          finished.add(input.sourceJobId);
        }),
      ...(releaseAvailable
        ? {
            releaseSourceJob: (input: { readonly sourceJobId: string }) =>
              Effect.gen(function* () {
                calls.releases.push(input.sourceJobId);
                if (current.fault === "release")
                  return yield* persistenceError("release-source-job");
              }),
          }
        : {}),
    }),
  );
  const layer = Layer.merge(cryptoLayer, WebPushDeliveries.layer.pipe(Layer.provide(deps)));
  const deliver = (payload: WebPushDeliveryPayload = activity) =>
    Effect.gen(function* () {
      const signed = yield* signWebPushDeliveryJob({
        secret: configuration.apnsDeliveryJobSigningSecret,
        payload,
      });
      const serialized: unknown = JSON.parse(JSON.stringify(signed));
      return yield* (yield* WebPushDeliveries.WebPushDeliveries).processSignedJob(serialized);
    });
  const noAttempt = () => {
    expect(calls.claims).toEqual([]);
    expect(calls.completes).toEqual([]);
    expect(calls.releases).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  };
  return { current, calls, transport, layer, deliver, noAttempt };
}

// Typed mutable fixtures model service boundaries, never replace the signed-job processor.
describe("current-authority Web Push consumer", () => {
  it.effect.each([
    ["plan_ready", "running", true],
    ["input_required", "waiting_for_input", false],
    ["input_required", "waiting_for_approval", false],
    ["agent_completed", "completed", false],
    ["agent_failed", "failed", false],
  ] as const)(
    "admits %s / %s with the matching current kind and category",
    ([kind, phase, plan]) => {
      const h = harness();
      h.current.state = { ...state, phase, hasActionableProposedPlan: plan };
      return Effect.gen(function* () {
        const p = {
          ...activity,
          provenance: {
            ...activity.provenance,
            notificationKind: kind,
            stateVersion: stateVersion(h.current.state ?? state),
          },
        };
        expect((yield* h.deliver(p)).ok).toBe(true);
        expect(h.transport).toHaveBeenCalledOnce();
        expect(h.calls.claims[0]).toMatchObject({
          environmentId: state.environmentId,
          threadId: state.threadId,
          sourceJobId: common.jobId,
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect.each([
    "notifyOnPlanReady",
    "notifyOnInput",
    "notifyOnCompletion",
    "notifyOnFailure",
    "enabled",
  ] as const)("denies disabled %s without lifecycle effects", (flag) => {
    const h = harness();
    h.current.subscription.preferencesJson = { ...preferences, [flag]: false };
    const kind =
      flag === "notifyOnPlanReady"
        ? "plan_ready"
        : flag === "notifyOnCompletion"
          ? "agent_completed"
          : flag === "notifyOnFailure"
            ? "agent_failed"
            : "input_required";
    return Effect.gen(function* () {
      expect(
        (yield* h.deliver({
          ...activity,
          provenance: { ...activity.provenance, notificationKind: kind },
        })).webPushReason,
      ).toBe("preferences_unavailable");
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    null,
    { ...state, updatedAt: "1970-01-01T00:00:01.000Z" },
    { ...state, phase: "running" },
    { ...state, hasActionableProposedPlan: true },
    { ...state, updatedAt: "invalid" },
  ] satisfies ReadonlyArray<RelayAgentActivityState | null>)(
    "denies changed/unavailable state %j",
    (row) => {
      const h = harness();
      h.current.state = row;
      return Effect.gen(function* () {
        expect((yield* h.deliver()).webPushReason).toBe("activity_unavailable");
        h.noAttempt();
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("denies a kind/state mismatch and an expired matching current state", () => {
    const h = harness();
    return Effect.gen(function* () {
      expect(
        (yield* h.deliver({
          ...activity,
          provenance: { ...activity.provenance, notificationKind: "agent_failed" },
        })).webPushReason,
      ).toBe("activity_unavailable");
      yield* TestClock.setTime(25 * 60 * 60 * 1000);
      const p = {
        ...activity,
        createdAt: "1970-01-02T01:00:00.000Z",
        expiresAt: "1970-01-02T01:01:00.000Z",
      };
      expect((yield* h.deliver(p)).webPushReason).toBe("activity_unavailable");
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "rebuilds current copy with queued names %s/current names %s",
    ([queued, current]) => {
      const h = harness();
      h.current.subscription.preferencesJson = {
        ...preferences,
        showProjectAndThreadNames: current,
      };
      h.current.state = {
        ...state,
        threadTitle: "Renamed",
        headline: "Fresh",
        projectTitle: "New Project",
        deepLink: "/fresh",
      };
      return Effect.gen(function* () {
        expect((yield* h.deliver({ ...activity, showProjectAndThreadNames: queued })).ok).toBe(
          true,
        );
        const wire: unknown = JSON.parse(String(h.transport.mock.calls[0]?.[1]));
        expect(wire).toEqual({
          eventId: activity.eventId,
          deepLink: "/fresh",
          showProjectAndThreadNames: queued && current,
          title: queued && current ? "Renamed" : "Arcwright Code",
          body: queued && current ? "Fresh · New Project" : "Agent activity needs your attention.",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "normalizes omitted plan bit, deduplicates honestly, and reauthorizes completed retries",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        expect((yield* h.deliver()).ok).toBe(true);
        expect(yield* h.deliver()).toMatchObject({
          ok: false,
          queued: false,
          webPushReason: "duplicate_job",
          apnsReason: null,
        });
        expect(h.transport).toHaveBeenCalledOnce();
        expect(h.calls.completes).toHaveLength(1);
        h.current.state = null;
        expect((yield* h.deliver()).webPushReason).toBe("activity_unavailable");
        expect(h.calls.claims).toHaveLength(2);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("explicit tests override automation and omit all incoming copy/source extras", () => {
    const h = harness();
    h.current.subscription.preferencesJson = {
      ...preferences,
      enabled: false,
      notifyOnInput: false,
      showProjectAndThreadNames: true,
    };
    return Effect.gen(function* () {
      const signed = yield* signWebPushDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload: testJob,
      });
      const body = {
        ...signed,
        payload: {
          ...signed.payload,
          title: "Injected",
          body: "Injected",
          eventId: "web:injected",
          provenance: activity.provenance,
          deepLink: "/secret",
          showProjectAndThreadNames: true,
        },
      };
      expect((yield* (yield* WebPushDeliveries.WebPushDeliveries).processSignedJob(body)).ok).toBe(
        true,
      );
      expect((yield* h.deliver(testJob)).webPushReason).toBe("duplicate_job");
      expect((yield* h.deliver({ ...testJob, jobId: "job-B" })).ok).toBe(true);
      expect(h.transport).toHaveBeenCalledTimes(2);
      expect(h.calls.activities).toBe(0);
      expect(JSON.parse(String(h.transport.mock.calls[0]?.[1]))).toEqual({
        eventId: `web-push-test:${subscription.id}`,
        title: "Arcwright Code",
        body: "Your PWA push notifications are working.",
        deepLink: "/",
        showProjectAndThreadNames: false,
      });
      expect(h.calls.claims[0]).toMatchObject({ environmentId: null, threadId: null });
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    { id: "another" },
    { userId: "another" },
    { incarnationId: linkIncarnationId },
    { endpoint: "http://bad" },
    { p256dh: "" },
    { auth: "" },
    { userId: "pwa:install" },
    { environmentId: "residual" },
    { installationId: "residual" },
    { installationSecretHash: "residual" },
  ])("denies current subscription mismatch/target/ownership %j for every V2 kind", (change) => {
    const h = harness();
    Object.assign(h.current.subscription, change);
    return Effect.gen(function* () {
      expect((yield* h.deliver()).ok).toBe(false);
      expect((yield* h.deliver(testJob)).ok).toBe(false);
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([
    "lookup",
    "activity",
    "claim",
    "complete",
    "release",
    "cleanup",
    "transport",
    "in_flight",
  ])("keeps %s failures typed and lifecycle honest", (fault) => {
    const h = harness();
    h.current.fault = fault;
    h.current.claim = fault;
    if (["transport", "release"].includes(fault))
      h.transport.mockRejectedValue(new Error("network"));
    if (fault === "cleanup") h.transport.mockRejectedValue({ statusCode: 410 });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(h.deliver());
      expect(error._tag).toBe("WebPushDeliveryTransportError");
      if (["transport", "release", "cleanup"].includes(fault))
        expect(h.calls.releases).toEqual([common.jobId]);
      else expect(h.calls.releases).toEqual([]);
      if (fault === "complete") expect(h.transport).toHaveBeenCalledOnce();
      if (["lookup", "activity", "claim", "in_flight"].includes(fault))
        expect(h.transport).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each([404, 410])(
    "completes %s with actual failure status and observed-incarnation cleanup",
    (status) => {
      const h = harness();
      h.transport.mockRejectedValue({ statusCode: status });
      return Effect.gen(function* () {
        expect(yield* h.deliver()).toMatchObject({
          ok: false,
          webPushStatus: status,
          webPushReason: "subscription_gone",
        });
        expect(h.calls.removes).toEqual([subscription.incarnationId]);
        expect(h.calls.completes).toEqual([
          { sourceJobId: common.jobId, apnsStatus: status, apnsReason: "subscription_gone" },
        ]);
        expect(h.calls.releases).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("releases a failed send then denies a stale retry without a new claim", () => {
    const h = harness();
    h.transport.mockRejectedValue(new Error("network"));
    return Effect.gen(function* () {
      yield* Effect.flip(h.deliver());
      h.current.subscription.incarnationId = linkIncarnationId;
      expect((yield* h.deliver()).ok).toBe(false);
      expect(h.calls.claims).toHaveLength(1);
      expect(h.calls.releases).toHaveLength(1);
      expect(h.transport).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("rejects malformed/expired/bad-MAC jobs before policy, DB and lifecycle", () => {
    const h = harness();
    return Effect.gen(function* () {
      const deliveries = yield* WebPushDeliveries.WebPushDeliveries;
      const signed = yield* signWebPushDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload: activity,
      });
      for (const body of [
        null,
        {},
        { ...signed, signature: "bad" },
        { ...signed, payload: { ...signed.payload, createdAt: "invalid" } },
      ])
        expect((yield* deliveries.processSignedJob(body)).webPushReason).toBe("invalid_job");
      yield* TestClock.setTime(600_000);
      expect((yield* deliveries.processSignedJob(signed)).webPushReason).toBe("invalid_job");
      expect(h.calls.gets).toBe(0);
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("fails typed before claiming when Web Push release capability is missing", () => {
    const h = harness(config, false);
    return Effect.gen(function* () {
      expect((yield* Effect.flip(h.deliver()))._tag).toBe("WebPushDeliveryTransportError");
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
  it.effect.each(["import", "verify"] as const)(
    "keeps %s crypto provider failures typed before DB",
    (operation) => {
      const h = harness();
      return Effect.scoped(
        Effect.gen(function* () {
          const signed = yield* signWebPushDeliveryJob({
            secret: config.apnsDeliveryJobSigningSecret,
            payload: activity,
          });
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              operation === "import"
                ? vi
                    .spyOn(globalThis.crypto.subtle, "importKey")
                    .mockRejectedValue(new Error("fixture import failure"))
                : vi
                    .spyOn(globalThis.crypto.subtle, "verify")
                    .mockRejectedValue(new Error("fixture verify failure")),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const error = yield* Effect.flip(
            (yield* WebPushDeliveries.WebPushDeliveries).processSignedJob(signed),
          );
          expect(error).toMatchObject({
            _tag: "WebPushDeliveryTransportError",
            cause: { _tag: "WebPushJobCryptoError", operation },
          });
          expect(h.calls.gets).toBe(0);
          h.noAttempt();
        }),
      ).pipe(Effect.provide(h.layer));
    },
  );
  it.effect.each(["plan_ready", "input_required", "agent_completed", "agent_failed"] as const)(
    "denies incompatible current phase/plan for %s",
    (kind) => {
      const h = harness();
      h.current.state = { ...state, phase: "running", hasActionableProposedPlan: false };
      return Effect.gen(function* () {
        expect(
          (yield* h.deliver({
            ...activity,
            provenance: {
              ...activity.provenance,
              notificationKind: kind,
              stateVersion: stateVersion(h.current.state ?? state),
            },
          })).webPushReason,
        ).toBe("activity_unavailable");
        h.noAttempt();
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("denies removal of a queued actionable plan bit", () => {
    const h = harness();
    h.current.state = { ...state, hasActionableProposedPlan: false };
    return Effect.gen(function* () {
      const source = {
        ...activity.provenance,
        notificationKind: "plan_ready",
        stateVersion: { ...activity.provenance.stateVersion, hasActionableProposedPlan: true },
      } satisfies WebPushActivityPayloadV2["provenance"];
      expect((yield* h.deliver({ ...activity, provenance: source })).webPushReason).toBe(
        "activity_unavailable",
      );
      h.noAttempt();
    }).pipe(Effect.provide(h.layer));
  });
});

describe("legacy anonymous V2 source limitations", () => {
  const legacy: RelayConfiguration["Service"] = { ...config, clerkAuthPolicy: { mode: "legacy" } };
  const anonymous = {
    ...subscription,
    userId: "pwa:installation-A",
    installationId: "installation-A",
    installationSecretHash: "hash",
    environmentId: state.environmentId,
  };
  const anonymousActivity: WebPushActivityPayloadV2 = {
    ...activity,
    userId: anonymous.userId,
    provenance: { ...activity.provenance, linkIncarnationId: null },
  };
  it.effect.each([
    ["plan_ready", "running", true, "An agent has a plan ready."],
    ["input_required", "waiting_for_input", false, "An agent needs your attention."],
    ["agent_completed", "completed", false, "An agent completed."],
    ["agent_failed", "failed", false, "An agent failed."],
  ] as const)(
    "uses generic transport copy for %s without account-state lookup",
    ([kind, phase, plan, body]) => {
      const h = harness(legacy);
      h.current.subscription = { ...anonymous };
      return Effect.gen(function* () {
        const p = {
          ...anonymousActivity,
          provenance: {
            ...anonymousActivity.provenance,
            notificationKind: kind,
            stateVersion: {
              ...anonymousActivity.provenance.stateVersion,
              phase,
              hasActionableProposedPlan: plan,
            },
          },
        };
        expect((yield* h.deliver(p)).ok).toBe(true);
        expect(h.calls.activities).toBe(0);
        expect(JSON.parse(String(h.transport.mock.calls[0]?.[1]))).toEqual({
          eventId: activity.eventId,
          title: "Arcwright Code",
          body,
          deepLink: "/",
          showProjectAndThreadNames: false,
        });
        expect(
          (yield* h.deliver({ ...testJob, userId: anonymous.userId, jobId: "test-job" })).ok,
        ).toBe(true);
        expect(JSON.parse(String(h.transport.mock.calls[1]?.[1]))).toMatchObject({
          eventId: `pwa-web-push-test:${anonymous.id}`,
          body: "Your PWA push notifications are working.",
        });
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect.each(["owned", "environment", "owner", "incarnation", "preferences", "kind", "age"])(
    "denies anonymous %s with zero attempt lifecycle",
    (failure) => {
      const h = harness(failure === "owned" ? config : legacy);
      h.current.subscription = { ...anonymous };
      if (failure === "environment") h.current.subscription.environmentId = "another";
      if (failure === "owner") h.current.subscription.installationId = "another";
      if (failure === "incarnation") h.current.subscription.incarnationId = linkIncarnationId;
      if (failure === "preferences")
        h.current.subscription.preferencesJson = { ...preferences, enabled: false };
      const p =
        failure === "kind"
          ? {
              ...anonymousActivity,
              provenance: {
                ...anonymousActivity.provenance,
                notificationKind: "agent_failed" as const,
              },
            }
          : anonymousActivity;
      return Effect.gen(function* () {
        if (failure === "age") yield* TestClock.setTime(25 * 60 * 60 * 1000);
        const input =
          failure === "age"
            ? { ...p, createdAt: "1970-01-02T01:00:00.000Z", expiresAt: "1970-01-02T01:01:00.000Z" }
            : p;
        expect((yield* h.deliver(input)).ok).toBe(false);
        h.noAttempt();
        expect(h.calls.activities).toBe(0);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("phase age after current authority observation", () => {
  it.effect.each(
    (["account", "anonymous"] as const).flatMap((ownership) =>
      [0, 1].map((pastExpiry) => ({ ownership, pastExpiry })),
    ),
  )(
    "rechecks %j source age after the getter returns with job TTL still valid",
    ({ ownership, pastExpiry }) =>
      Effect.gen(function* () {
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const returnedAt = 86_400_000 + pastExpiry;
        const h = harness(
          ownership === "account" ? config : { ...config, clerkAuthPolicy: { mode: "legacy" } },
          true,
          {
            clock,
            accountReturnedAt: ownership === "account" ? returnedAt : null,
            subscriptionReturnedAt: ownership === "anonymous" ? returnedAt : null,
          },
        );
        if (ownership === "anonymous")
          h.current.subscription = {
            ...subscription,
            userId: "pwa:installation-A",
            installationId: "installation-A",
            installationSecretHash: "hash",
            environmentId: state.environmentId,
          };
        const payload: WebPushActivityPayloadV2 =
          ownership === "account"
            ? activity
            : {
                ...activity,
                userId: "pwa:installation-A",
                provenance: { ...activity.provenance, linkIncarnationId: null },
              };
        yield* clock.setTime(86_399_999);
        const result = yield* h
          .deliver({
            ...payload,
            createdAt: "1970-01-01T23:59:59.000Z",
            expiresAt: "1970-01-02T00:09:59.000Z",
          })
          .pipe(Effect.provide(h.layer));
        expect(clock.currentTimeMillisUnsafe()).toBe(returnedAt);
        expect(h.calls.gets).toBe(1);
        expect(h.calls.activities).toBe(ownership === "account" ? 1 : 0);
        if (pastExpiry === 0) {
          expect(result.ok).toBe(true);
          expect(h.calls.claims).toHaveLength(1);
          expect(h.calls.completes).toHaveLength(1);
          expect(h.calls.releases).toEqual([]);
          expect(h.transport).toHaveBeenCalledOnce();
        } else {
          expect(result).toMatchObject({
            ok: false,
            queued: false,
            webPushReason: "activity_unavailable",
          });
          h.noAttempt();
        }
      }),
  );
});
