import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { RelayDeliveryResult } from "@t3tools/contracts/relay";

import { anonymousPwaAllowed } from "./anonymousPwaPolicy.ts";
import * as RelayConfiguration from "../Config.ts";
import * as WebCrypto from "../WebCrypto.ts";
import {
  expiresAtForWebPushJob,
  signWebPushDeliveryJob,
  type SignedWebPushDeliveryJob,
  type WebPushActivityPayloadV2,
  type WebPushTestPayloadV2,
} from "./webPushDeliveryJobs.ts";

export class WebPushDeliveryQueueError extends Schema.TaggedError<WebPushDeliveryQueueError>()(
  "WebPushDeliveryQueueError",
  { cause: Schema.Defect() },
) {}

export class WebPushDeliveryQueueSender extends Context.Service<
  WebPushDeliveryQueueSender,
  {
    readonly send: (
      body: SignedWebPushDeliveryJob,
    ) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveryQueue/WebPushDeliveryQueueSender") {}

type QueueInput<Payload> = Payload extends WebPushActivityPayloadV2 | WebPushTestPayloadV2
  ? Omit<Payload, "version" | "jobId" | "createdAt" | "expiresAt">
  : never;
export type WebPushQueueInput = QueueInput<WebPushActivityPayloadV2 | WebPushTestPayloadV2>;

export class WebPushDeliveryQueue extends Context.Service<
  WebPushDeliveryQueue,
  {
    readonly enqueue: (
      input: WebPushQueueInput,
    ) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryQueueError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveryQueue") {}

export const make = Effect.gen(function* () {
  const anonymousAllowed = yield* anonymousPwaAllowed;
  const sender = yield* WebPushDeliveryQueueSender;
  const webCrypto = yield* WebCrypto.WebCrypto;
  const crypto = yield* Crypto.Crypto;
  const config = yield* RelayConfiguration.RelayConfiguration;
  return WebPushDeliveryQueue.of({
    enqueue: Effect.fn("relay.web_push_delivery_queue.enqueue")(function* (input) {
      if (!anonymousAllowed && input.userId.startsWith("pwa:")) {
        return {
          deviceId: input.subscriptionId,
          kind: "web_push_notification" as const,
          ok: false,
          queued: false,
          apnsStatus: null,
          apnsReason: null,
          apnsId: null,
          webPushReason: "anonymous_pwa_unavailable",
        };
      }
      const now = yield* DateTime.now;
      const jobId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new WebPushDeliveryQueueError({ cause })));
      const payload = {
        version: 2 as const,
        jobId,
        ...input,
        createdAt: DateTime.formatIso(now),
        expiresAt: expiresAtForWebPushJob(now.epochMilliseconds),
      };
      const signed = yield* signWebPushDeliveryJob({
        secret: config.webPushDeliveryJobSigningSecret ?? config.apnsDeliveryJobSigningSecret,
        payload,
      }).pipe(
        Effect.provideService(WebCrypto.WebCrypto, webCrypto),
        Effect.mapError((cause) => new WebPushDeliveryQueueError({ cause })),
      );
      yield* sender
        .send(signed)
        .pipe(Effect.mapError((cause) => new WebPushDeliveryQueueError({ cause })));
      return {
        deviceId: input.subscriptionId,
        kind: "web_push_notification" as const,
        ok: true,
        queued: true,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
      };
    }),
  });
});

export const layer = Layer.effect(WebPushDeliveryQueue, make);

export const layerCloudflareQueues = (
  sender: Cloudflare.Queues.WriteQueueClient,
  runtime: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        WebPushDeliveryQueueSender,
        WebPushDeliveryQueueSender.of({
          send: (body) =>
            sender.send(body).pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
        }),
      ),
    ),
  );
