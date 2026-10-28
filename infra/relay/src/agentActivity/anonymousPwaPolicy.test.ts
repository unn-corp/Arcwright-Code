import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import webpush from "web-push";
import { vi } from "vite-plus/test";

import { RelayConfiguration } from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as WebCrypto from "../WebCrypto.ts";
const webCryptoLayer = Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle });
import * as AgentActivityRows from "./AgentActivityRows.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import * as WebPushDeliveries from "./WebPushDeliveries.ts";
import * as WebPushDeliveryQueue from "./WebPushDeliveryQueue.ts";
import * as WebPushRuntime from "./webPushRuntime.ts";
import { signWebPushDeliveryJob } from "./webPushDeliveryJobs.ts";

vi.mock("web-push", () => ({
  default: { sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })) },
}));

const ownedConfig: RelayConfiguration["Service"] = {
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
  apnsDeliveryJobSigningSecret: Redacted.make("fixture-delivery-secret"),
  webPush: {
    subject: "mailto:fixture@example.test",
    publicKey: "fixture-key",
    privateKey: Redacted.make("fixture-key"),
  },
  cloudMintPrivateKey: Redacted.make("fixture-key"),
  cloudMintPublicKey: "fixture-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const anonymousSubscription: WebPushSubscriptions.WebPushNotification["subscription"] = {
  id: "fixture-subscription",
  incarnationId: "00000000-0000-4000-8000-000000000001",
  userId: "pwa:fixture-installation",
  environmentId: "fixture-environment",
  installationId: "fixture-installation",
  installationSecretHash: "fixture-hash",
  endpoint: "https://push.example.test/fixture",
  p256dh: "fixture-key",
  auth: "fixture-auth",
  preferencesJson: {
    enabled: true,
    notifyOnCompletion: true,
    notifyOnPlanReady: true,
    notifyOnInput: true,
    notifyOnFailure: true,
    showProjectAndThreadNames: false,
  },
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
};
const payload = {
  eventId: "fixture-event",
  deepLink: "/",
  showProjectAndThreadNames: false,
  title: "Fixture",
  body: "Fixture",
};

function guardedRuntime(
  configuration: RelayConfiguration["Service"],
  subscription = anonymousSubscription,
) {
  const calls = { db: 0, crypto: 0, claims: 0, sends: 0 };
  const db = new Proxy(
    {},
    {
      get: () => {
        calls.db++;
        throw new Error("Disabled anonymous path accessed DB");
      },
    },
  ) as RelayDb.RelayDb["Service"];
  const crypto = Layer.effect(
    Crypto.Crypto,
    Effect.gen(function* () {
      const original = yield* Crypto.Crypto;
      return Crypto.Crypto.of({
        ...original,
        randomUUIDv4: ((options?: Parameters<Crypto.Crypto["randomUUIDv4"]>[0]) =>
          original.randomUUIDv4(options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                calls.crypto++;
              }),
            ),
          )) as Crypto.Crypto["randomUUIDv4"],
        digest: (...args) => {
          calls.crypto++;
          return original.digest(...args);
        },
      });
    }),
  ).pipe(Layer.provide(NodeCrypto.layer));
  const attempts = Layer.succeed(DeliveryAttempts.DeliveryAttempts, {
    record: () => Effect.void,
    pruneExpired: Effect.succeed(0),
    claimSourceJob: () =>
      Effect.sync(() => {
        calls.claims++;
        return "claimed" as const;
      }),
    completeSourceJob: () => Effect.void,
    releaseSourceJob: () => Effect.void,
  });
  const deps = Layer.mergeAll(
    Layer.mock(AgentActivityRows.AgentActivityRows, {}),
    crypto,
    webCryptoLayer,
    attempts,
    Layer.succeed(RelayDb.RelayDb, db),
    Layer.succeed(RelayConfiguration, configuration),
  );
  return { calls, deps, subscription };
}

describe("owned Worker Web Push assembly", () => {
  it.effect.each([
    ownedConfig,
    { ...ownedConfig, clerkPublishableKey: "malformed" },
    {
      ...ownedConfig,
      clerkAuthPolicy: { mode: "owned" } as NonNullable<
        RelayConfiguration["Service"]["clerkAuthPolicy"]
      >,
    },
  ])("rejects anonymous services before persistence and crypto for policy %j", (configuration) => {
    const { calls, deps } = guardedRuntime(configuration);
    return Effect.gen(function* () {
      const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
      const installation = {
        installationId: "fixture-installation",
        installationSecret: "fixture-secret",
      };
      expect(
        (yield* Effect.flip(
          subscriptions.registerPwa({
            payload: {
              installation,
              environmentId: EnvironmentId.make("fixture-environment"),
              endpoint: anonymousSubscription.endpoint,
              keys: { p256dh: "key", auth: "auth" },
              preferences: anonymousSubscription.preferencesJson,
            },
          }),
        ))._tag,
      ).toBe("AnonymousPwaUnavailable");
      expect(
        (yield* Effect.flip(
          subscriptions.getPwa({ ...installation, subscriptionId: "fixture-subscription" }),
        ))._tag,
      ).toBe("AnonymousPwaUnavailable");
      expect(
        yield* subscriptions.transitionEnvironment({
          environmentId: "fixture-environment",
          state: {
            environmentId: EnvironmentId.make("fixture-environment"),
            threadId: ThreadId.make("fixture-thread"),
            projectTitle: "Private Project",
            threadTitle: "Private Thread",
            modelTitle: "Codex",
            phase: "running",
            headline: "Running",
            updatedAt: "1970-01-01T00:00:00.000Z",
            deepLink: "/",
          },
        }),
      ).toEqual([]);
      const deliveries = yield* WebPushDeliveries.WebPushDeliveries;
      const job = yield* signWebPushDeliveryJob({
        secret: configuration.apnsDeliveryJobSigningSecret,
        payload: {
          version: 1,
          jobId: "fixture-job",
          userId: anonymousSubscription.userId,
          subscriptionId: anonymousSubscription.id,
          ...payload,
          createdAt: "1970-01-01T00:00:00.000Z",
          expiresAt: "1970-01-01T00:05:00.000Z",
        },
      });
      expect((yield* deliveries.processSignedJob(job)).webPushReason).toBe("v1_unavailable");
      // Invalid signatures are rejected before deployment policy or reads.
      expect(
        (yield* deliveries.processSignedJob({ ...job, signature: "invalid" })).webPushReason,
      ).toBe("invalid_job");
      expect(
        (yield* deliveries.send({ subscription: anonymousSubscription, payload })).webPushReason,
      ).toBe("anonymous_pwa_unavailable");
      expect(calls).toEqual({ db: 0, crypto: 0, claims: 0, sends: 0 });
    }).pipe(
      Effect.provide(Layer.merge(WebPushRuntime.layer.pipe(Layer.provide(deps)), webCryptoLayer)),
    );
  });

  it.effect(
    "blocks anonymous queue production before crypto and send, while account jobs still queue",
    () => {
      const { calls, deps } = guardedRuntime(ownedConfig);
      return Effect.gen(function* () {
        const queue = yield* WebPushDeliveryQueue.WebPushDeliveryQueue;
        expect(
          (yield* queue.enqueue({
            kind: "test",
            subscriptionIncarnationId: anonymousSubscription.incarnationId,
            userId: "pwa:fixture-installation",
            subscriptionId: "fixture-subscription",
          })).queued,
        ).toBe(false);
        expect(calls.crypto).toBe(0);
        expect(calls.sends).toBe(0);
        expect(
          (yield* queue.enqueue({
            kind: "test",
            subscriptionIncarnationId: anonymousSubscription.incarnationId,
            userId: "user_fixture",
            subscriptionId: "fixture-subscription",
          })).queued,
        ).toBe(true);
        expect(calls.crypto).toBe(1);
        expect(calls.sends).toBe(1);
      }).pipe(
        Effect.provide(
          WebPushDeliveryQueue.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(AgentActivityRows.AgentActivityRows, {}),
                deps,
                Layer.succeed(WebPushDeliveryQueue.WebPushDeliveryQueueSender, {
                  send: () =>
                    Effect.sync(() => {
                      calls.sends++;
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect.each(["owned", "legacy"] as const)(
    "rejects account rows with residual installation authority in %s delivery before claims",
    (mode) => {
      const config =
        mode === "owned"
          ? ownedConfig
          : { ...ownedConfig, clerkAuthPolicy: { mode: "legacy" as const } };
      const contaminated = { ...anonymousSubscription, userId: "user_fixture" };
      let claims = 0;
      const transport = vi
        .spyOn(webpush, "sendNotification")
        .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      return Effect.gen(function* () {
        const deliveries = yield* WebPushDeliveries.WebPushDeliveries;
        expect((yield* deliveries.send({ subscription: contaminated, payload })).ok).toBe(false);
        const job = yield* signWebPushDeliveryJob({
          secret: config.apnsDeliveryJobSigningSecret,
          payload: {
            version: 1,
            jobId: "fixture-job",
            userId: contaminated.userId,
            subscriptionId: contaminated.id,
            ...payload,
            createdAt: "1970-01-01T00:00:00.000Z",
            expiresAt: "1970-01-01T00:05:00.000Z",
          },
        });
        expect((yield* deliveries.processSignedJob(job)).ok).toBe(false);
        expect(claims).toBe(0);
        expect(transport).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          Layer.merge(
            webCryptoLayer,
            WebPushDeliveries.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(AgentActivityRows.AgentActivityRows, {}),
                  webCryptoLayer,
                  Layer.succeed(RelayConfiguration, config),
                  Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
                    get: () => Effect.succeed(contaminated),
                  }),
                  Layer.mock(DeliveryAttempts.DeliveryAttempts, {
                    releaseSourceJob: () => Effect.void,
                    claimSourceJob: () =>
                      Effect.sync(() => {
                        claims++;
                        return "claimed" as const;
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => transport.mockRestore())),
      );
    },
  );

  it.effect("retains legacy anonymous delivery and owned clean account delivery", () => {
    const transport = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    return Effect.gen(function* () {
      for (const [config, subscription] of [
        [{ ...ownedConfig, clerkAuthPolicy: { mode: "legacy" as const } }, anonymousSubscription],
        [
          ownedConfig,
          {
            ...anonymousSubscription,
            userId: "pwa:account_name",
            environmentId: null,
            installationId: null,
            installationSecretHash: null,
          },
        ],
        [
          ownedConfig,
          {
            ...anonymousSubscription,
            userId: "user_fixture",
            environmentId: null,
            installationId: null,
            installationSecretHash: null,
          },
        ],
      ] as const) {
        const deliveries = yield* WebPushDeliveries.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(AgentActivityRows.AgentActivityRows, {}),
              webCryptoLayer,
              Layer.succeed(RelayConfiguration, config),
              Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {}),
              Layer.mock(DeliveryAttempts.DeliveryAttempts, {
                releaseSourceJob: () => Effect.void,
              }),
            ),
          ),
        );
        expect((yield* deliveries.send({ subscription, payload })).ok).toBe(true);
      }
      expect(transport).toHaveBeenCalledTimes(3);
    }).pipe(
      Effect.provide(webCryptoLayer),
      Effect.ensuring(Effect.sync(() => transport.mockRestore())),
    );
  });
});

it.effect("consumes valid legacy V1 and permanently rejects owned account V1 before claims", () => {
  const transport = vi
    .spyOn(webpush, "sendNotification")
    .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  return Effect.gen(function* () {
    for (const [config, subscription] of [
      [{ ...ownedConfig, clerkAuthPolicy: { mode: "legacy" as const } }, anonymousSubscription],
      [
        ownedConfig,
        {
          ...anonymousSubscription,
          userId: "user_fixture",
          environmentId: null,
          installationId: null,
          installationSecretHash: null,
        },
      ],
    ] as const) {
      let claims = 0;
      let completions = 0;
      const deliveries = yield* WebPushDeliveries.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AgentActivityRows.AgentActivityRows, {}),
            webCryptoLayer,
            Layer.succeed(RelayConfiguration, config),
            Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
              get: () => Effect.succeed(subscription),
            }),
            Layer.mock(DeliveryAttempts.DeliveryAttempts, {
              releaseSourceJob: () => Effect.void,
              claimSourceJob: () =>
                Effect.sync(() => {
                  claims++;
                  return "claimed" as const;
                }),
              completeSourceJob: () =>
                Effect.sync(() => {
                  completions++;
                }),
            }),
          ),
        ),
      );
      const job = yield* signWebPushDeliveryJob({
        secret: config.apnsDeliveryJobSigningSecret,
        payload: {
          version: 1,
          jobId: "fixture-job",
          userId: subscription.userId,
          subscriptionId: subscription.id,
          ...payload,
          createdAt: "1970-01-01T00:00:00.000Z",
          expiresAt: "1970-01-01T00:05:00.000Z",
        },
      });
      expect((yield* deliveries.processSignedJob(job)).ok).toBe(
        config.clerkAuthPolicy?.mode === "legacy",
      );
      expect(claims).toBe(config.clerkAuthPolicy?.mode === "legacy" ? 1 : 0);
      expect(completions).toBe(config.clerkAuthPolicy?.mode === "legacy" ? 1 : 0);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  }).pipe(
    Effect.provide(webCryptoLayer),
    Effect.ensuring(Effect.sync(() => transport.mockRestore())),
  );
});

it.effect.each(["owned", "legacy"] as const)(
  "%s revalidates V2 ownership before claims and transport",
  (mode) => {
    const config =
      mode === "owned"
        ? ownedConfig
        : { ...ownedConfig, clerkAuthPolicy: { mode: "legacy" as const } };
    const { deps, calls } = guardedRuntime(config);
    let lookups = 0;
    vi.mocked(webpush.sendNotification).mockClear();
    return Effect.gen(function* () {
      const deliveries = yield* WebPushDeliveries.WebPushDeliveries;
      const common = {
        version: 2,
        jobId: "fixture-job",
        userId: "user_fixture",
        subscriptionId: "fixture-subscription",
        subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:10:00.000Z",
      } as const;
      for (const payload of [
        { ...common, kind: "test" } as const,
        {
          ...common,
          kind: "activity",
          eventId: "test-looking:opaque",
          showProjectAndThreadNames: true,
          provenance: {
            environmentId: "verified-env",
            environmentPublicKey: "verified-key",
            threadId: "thread",
            linkIncarnationId: "00000000-0000-4000-8000-000000000002",
            notificationKind: "plan_ready",
            stateVersion: {
              updatedAt: common.createdAt,
              phase: "running",
              hasActionableProposedPlan: true,
            },
          },
        } as const,
      ]) {
        const job = yield* signWebPushDeliveryJob({
          secret: config.apnsDeliveryJobSigningSecret,
          payload,
        });
        expect((yield* deliveries.processSignedJob(job)).webPushReason).toBe(
          "subscription_unavailable",
        );
        expect(
          (yield* deliveries.processSignedJob({ ...job, signature: "malformed" })).webPushReason,
        ).toBe("invalid_job");
      }
      if (mode === "owned") {
        for (const eventId of [
          "web-push-test:fixture-subscription",
          "pwa-web-push-test:fixture-subscription",
          "opaque",
        ]) {
          const job = yield* signWebPushDeliveryJob({
            secret: config.apnsDeliveryJobSigningSecret,
            payload: {
              ...common,
              version: 1,
              eventId,
              title: "Untrusted",
              body: "Untrusted",
              deepLink: "/",
              showProjectAndThreadNames: true,
            },
          });
          expect((yield* deliveries.processSignedJob(job)).webPushReason).toBe("v1_unavailable");
        }
      }
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(lookups).toBe(2);
      expect(calls).toEqual({ db: 0, crypto: 0, claims: 0, sends: 0 });
    }).pipe(
      Effect.provide(
        Layer.merge(
          webCryptoLayer,
          WebPushDeliveries.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(AgentActivityRows.AgentActivityRows, {}),
                deps,
                Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
                  get: () =>
                    Effect.sync(() => {
                      lookups++;
                      return anonymousSubscription;
                    }),
                }),
              ),
            ),
          ),
        ),
      ),
    );
  },
);

it.effect("keeps consumer crypto provider failures retryable without lookup or claims", () => {
  const config = { ...ownedConfig, clerkAuthPolicy: { mode: "legacy" as const } };
  const { deps, calls } = guardedRuntime(config);
  let lookups = 0;
  return Effect.gen(function* () {
    const deliveries = yield* WebPushDeliveries.WebPushDeliveries;
    const job = yield* signWebPushDeliveryJob({
      secret: config.apnsDeliveryJobSigningSecret,
      payload: {
        version: 2,
        kind: "test",
        jobId: "fixture-job",
        userId: "user_fixture",
        subscriptionId: "fixture-subscription",
        subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-01T00:10:00.000Z",
      },
    });
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi
          .spyOn(globalThis.crypto.subtle, "verify")
          .mockRejectedValue(new Error("provider failure")),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const result = yield* Effect.result(deliveries.processSignedJob(job));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        _tag: "WebPushDeliveryTransportError",
        cause: { _tag: "WebPushJobCryptoError", operation: "verify" },
      });
    expect(lookups).toBe(0);
    expect(calls.claims).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.merge(
        webCryptoLayer,
        WebPushDeliveries.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(AgentActivityRows.AgentActivityRows, {}),
              deps,
              Layer.mock(WebPushSubscriptions.WebPushSubscriptions, {
                get: () =>
                  Effect.sync(() => {
                    lookups++;
                    return anonymousSubscription;
                  }),
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
});
