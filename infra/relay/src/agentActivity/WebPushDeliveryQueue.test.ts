import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { RelayConfiguration } from "../Config.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as WebPushDeliveryQueue from "./WebPushDeliveryQueue.ts";
import { verifyWebPushDeliveryJob, type SignedWebPushDeliveryJob } from "./webPushDeliveryJobs.ts";

const secret = Redacted.make("queue-secret-世界");
const config: RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("fixture"),
  clerkPublishableKey: "fixture",
  clerkJwtAudience: "fixture",
  apnsDeliveryJobSigningSecret: secret,
  cloudMintPrivateKey: Redacted.make("fixture"),
  cloudMintPublicKey: "fixture",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};
const source = {
  environmentId: "environment",
  environmentPublicKey: "verified-key",
  threadId: "thread",
  notificationKind: "input_required",
  stateVersion: {
    updatedAt: "1970-01-01T00:00:00.000Z",
    phase: "waiting_for_input",
    hasActionableProposedPlan: false,
  },
} as const;
const accountActivity = {
  kind: "activity",
  userId: "user",
  subscriptionId: "subscription",
  subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
  eventId: "web-push-test:opaque",
  showProjectAndThreadNames: true,
  provenance: { ...source, linkIncarnationId: "00000000-0000-4000-8000-000000000002" },
} as const;
const anonymousActivity = {
  ...accountActivity,
  userId: "pwa:installation",
  provenance: { ...source, linkIncarnationId: null },
} as const;
const explicitTest = {
  kind: "test",
  userId: "user",
  subscriptionId: "subscription",
  subscriptionIncarnationId: "00000000-0000-4000-8000-000000000001",
} as const;
const webCryptoLayer = Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle });

function queueLayer(jobs: Array<SignedWebPushDeliveryJob>) {
  return WebPushDeliveryQueue.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        webCryptoLayer,
        Layer.succeed(RelayConfiguration, config),
        Layer.succeed(WebPushDeliveryQueue.WebPushDeliveryQueueSender, {
          send: (body) =>
            Effect.sync(() => {
              jobs.push(body);
            }),
        }),
      ),
    ),
  );
}

describe("actual Web Push queue production", () => {
  it.effect.each([accountActivity, anonymousActivity, explicitTest])(
    "queues signed V2 $kind/$userId with selected incarnation and honest acceptance",
    (input) => {
      const jobs: Array<SignedWebPushDeliveryJob> = [];
      return Effect.gen(function* () {
        const queue = yield* WebPushDeliveryQueue.WebPushDeliveryQueue;
        const result = yield* queue.enqueue(input);
        expect(result).toMatchObject({ ok: true, queued: true, deviceId: input.subscriptionId });
        expect(jobs).toHaveLength(1);
        const job = jobs[0]!;
        expect(job.payload).toMatchObject({ ...input, version: 2 });
        expect(job.payload).not.toHaveProperty("title");
        expect(job.payload).not.toHaveProperty("body");
        expect(job.payload).not.toHaveProperty("deepLink");
        expect(
          yield* verifyWebPushDeliveryJob({
            secret,
            job,
            nowMs: (yield* DateTime.now).epochMilliseconds,
          }),
        ).toEqual(job.payload);
        if (input.kind === "test") {
          expect(job.payload).not.toHaveProperty("eventId");
          expect(job.payload).not.toHaveProperty("provenance");
          expect(job.payload).not.toHaveProperty("showProjectAndThreadNames");
        }
      }).pipe(Effect.provide(Layer.merge(queueLayer(jobs), webCryptoLayer)));
    },
  );

  it.effect.each(["importKey", "sign"] as const)(
    "provider %s failure is typed and sends zero jobs",
    (method) => {
      const jobs: Array<SignedWebPushDeliveryJob> = [];
      return Effect.gen(function* () {
        const queue = yield* WebPushDeliveryQueue.WebPushDeliveryQueue;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(globalThis.crypto.subtle, method)
              .mockRejectedValue(new Error("provider unavailable")),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const result = yield* Effect.result(queue.enqueue(explicitTest));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "WebPushDeliveryQueueError",
            cause: {
              _tag: "WebPushJobCryptoError",
              operation: method === "importKey" ? "import" : "sign",
            },
          });
        expect(jobs).toHaveLength(0);
      }).pipe(Effect.provide(queueLayer(jobs)), Effect.scoped);
    },
  );
});
