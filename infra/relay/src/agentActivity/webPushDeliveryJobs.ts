import { RelayAgentAwarenessPhase } from "@t3tools/contracts/relay";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as WebCrypto from "../WebCrypto.ts";

const MAX_JOB_AGE_MS = 10 * 60 * 1_000;
export const WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM = "hmac-sha256";

// Frozen historical canonical fields: legacy queued copies remain V1 only.
export const WebPushDeliveryPayloadV1 = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  userId: Schema.String,
  subscriptionId: Schema.String,
  eventId: Schema.String,
  deepLink: Schema.String,
  showProjectAndThreadNames: Schema.Boolean,
  title: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type WebPushDeliveryPayloadV1 = typeof WebPushDeliveryPayloadV1.Type;

const IncarnationId = Schema.String.check(Schema.isUUID());
export const WebPushNotificationKind = Schema.Literals([
  "plan_ready",
  "input_required",
  "agent_completed",
  "agent_failed",
]);
export type WebPushNotificationKind = typeof WebPushNotificationKind.Type;
export const WebPushStateVersion = Schema.Struct({
  updatedAt: Schema.String,
  phase: RelayAgentAwarenessPhase,
  hasActionableProposedPlan: Schema.Boolean,
});
const sourceFields = {
  environmentId: Schema.String,
  environmentPublicKey: Schema.String,
  threadId: Schema.String,
  notificationKind: WebPushNotificationKind,
  stateVersion: WebPushStateVersion,
};
const commonV2 = {
  version: Schema.Literal(2),
  jobId: Schema.String,
  subscriptionId: Schema.String,
  subscriptionIncarnationId: IncarnationId,
  createdAt: Schema.String,
  expiresAt: Schema.String,
};
const activityFields = {
  ...commonV2,
  kind: Schema.Literal("activity"),
  eventId: Schema.String,
  showProjectAndThreadNames: Schema.Boolean,
};
export const WebPushActivityPayloadV2 = Schema.Union([
  Schema.Struct({
    ...activityFields,
    userId: Schema.String.check(Schema.isPattern(/^(?!pwa:)/)),
    provenance: Schema.Struct({ ...sourceFields, linkIncarnationId: IncarnationId }),
  }),
  Schema.Struct({
    ...activityFields,
    userId: Schema.String.check(Schema.isPattern(/^pwa:/)),
    provenance: Schema.Struct({ ...sourceFields, linkIncarnationId: Schema.Null }),
  }),
]);
export type WebPushActivityPayloadV2 = typeof WebPushActivityPayloadV2.Type;
export const WebPushTestPayloadV2 = Schema.Struct({
  ...commonV2,
  kind: Schema.Literal("test"),
  userId: Schema.String,
});
export type WebPushTestPayloadV2 = typeof WebPushTestPayloadV2.Type;
export const WebPushDeliveryPayloadV2 = Schema.Union([
  WebPushActivityPayloadV2,
  WebPushTestPayloadV2,
]);
export type WebPushDeliveryPayloadV2 = typeof WebPushDeliveryPayloadV2.Type;
export const WebPushDeliveryPayload = Schema.Union([
  WebPushDeliveryPayloadV1,
  WebPushDeliveryPayloadV2,
]);
export type WebPushDeliveryPayload = typeof WebPushDeliveryPayload.Type;
export const SignedWebPushDeliveryJob = Schema.Struct({
  algorithm: Schema.Literal(WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM),
  payload: WebPushDeliveryPayload,
  signature: Schema.String,
});
export type SignedWebPushDeliveryJob = typeof SignedWebPushDeliveryJob.Type;

export class WebPushJobCryptoError extends Schema.TaggedError<WebPushJobCryptoError>()(
  "WebPushJobCryptoError",
  {
    operation: Schema.Literals(["import", "sign", "verify"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Web Push job cryptography is temporarily unavailable.";
  }
}

const importKey = (
  subtle: SubtleCrypto,
  secret: Redacted.Redacted<string>,
  usage: "sign" | "verify",
) =>
  Effect.tryPromise({
    try: () =>
      subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        [usage],
      ),
    catch: (cause) => new WebPushJobCryptoError({ operation: "import", cause }),
  });

const decodePayload = Schema.decodeEffect(WebPushDeliveryPayload);

export const signWebPushDeliveryJob = Effect.fnUntraced(function* (input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: WebPushDeliveryPayload;
}) {
  // Decode before signing: test extras cannot become signed copy or source authority.
  const payload = yield* decodePayload(input.payload);
  const { subtle } = yield* WebCrypto.WebCrypto;
  const key = yield* importKey(subtle, input.secret, "sign");
  const signature = yield* Effect.tryPromise({
    try: () => subtle.sign("HMAC", key, new TextEncoder().encode(stableStringify(payload))),
    catch: (cause) => new WebPushJobCryptoError({ operation: "sign", cause }),
  });
  return {
    algorithm: WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM,
    payload,
    signature: Base64Url.encode(new Uint8Array(signature)),
  } satisfies SignedWebPushDeliveryJob;
});

export const verifyWebPushDeliveryJob = Effect.fnUntraced(function* (input: {
  readonly secret: Redacted.Redacted<string>;
  readonly job: SignedWebPushDeliveryJob;
  readonly nowMs: number;
}) {
  const received = Base64Url.decode(input.job.signature);
  if (Result.isFailure(received) || received.success.length !== 32) return null;
  const createdAt = DateTime.make(input.job.payload.createdAt);
  const expiresAt = DateTime.make(input.job.payload.expiresAt);
  if (Option.isNone(createdAt) || Option.isNone(expiresAt)) return null;
  if (
    expiresAt.value.epochMilliseconds <= createdAt.value.epochMilliseconds ||
    expiresAt.value.epochMilliseconds - createdAt.value.epochMilliseconds > MAX_JOB_AGE_MS ||
    expiresAt.value.epochMilliseconds <= input.nowMs
  )
    return null;
  const { subtle } = yield* WebCrypto.WebCrypto;
  const key = yield* importKey(subtle, input.secret, "verify");
  // Copy the decoder's bytes into an ArrayBuffer-backed view for Workers subtle.
  const mac = new Uint8Array(received.success.length);
  mac.set(received.success);
  const valid = yield* Effect.tryPromise({
    try: () =>
      subtle.verify("HMAC", key, mac, new TextEncoder().encode(stableStringify(input.job.payload))),
    catch: (cause) => new WebPushJobCryptoError({ operation: "verify", cause }),
  });
  if (!valid) return null;
  return input.job.payload;
});

export function expiresAtForWebPushJob(createdAtMs: number): string {
  return DateTime.formatIso(Option.getOrThrow(DateTime.make(createdAtMs + MAX_JOB_AGE_MS)));
}
