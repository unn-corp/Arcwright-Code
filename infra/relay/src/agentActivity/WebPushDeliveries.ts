import type { RelayDeliveryResult } from "@t3tools/contracts/relay";
import {
  RelayWebPushPreferences,
  RelayWebPushSubscriptionRegistrationRequest,
} from "@t3tools/contracts/relay";
import webpush from "web-push";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as WebCrypto from "../WebCrypto.ts";
import { anonymousPwaAllowed, blocksWebPushDelivery } from "./anonymousPwaPolicy.ts";
import * as AgentActivityRows from "./AgentActivityRows.ts";
import { agentActivityExpiresAt, isExpiredAgentActivityState } from "./agentActivityPayloads.ts";
import {
  notificationCopy,
  wantsNotification,
  stateVersion,
  kindFitsState,
} from "./webPushNotifications.ts";
import * as DeliveryAttempts from "./DeliveryAttempts.ts";
import * as WebPushSubscriptions from "./WebPushSubscriptions.ts";
import { SignedWebPushDeliveryJob, verifyWebPushDeliveryJob } from "./webPushDeliveryJobs.ts";

export type WebPushPayload = {
  readonly eventId: string;
  readonly deepLink: string;
  readonly showProjectAndThreadNames: boolean;
  readonly title: string;
  readonly body: string;
};

const WebPushPayloadJson = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      eventId: Schema.String,
      deepLink: Schema.String,
      showProjectAndThreadNames: Schema.Boolean,
      title: Schema.String,
      body: Schema.String,
    }),
  ),
);

function responseStatus(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || !("statusCode" in cause)) return null;
  const statusCode = cause.statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

export class WebPushDeliveryTransportError extends Schema.TaggedError<WebPushDeliveryTransportError>()(
  "WebPushDeliveryTransportError",
  { cause: Schema.Defect() },
) {}

export class WebPushDeliveries extends Context.Service<
  WebPushDeliveries,
  {
    readonly send: (input: {
      readonly subscription: WebPushSubscriptions.WebPushNotification["subscription"];
      readonly payload: WebPushPayload;
    }) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryTransportError>;
    readonly processSignedJob: (
      body: unknown,
    ) => Effect.Effect<RelayDeliveryResult, WebPushDeliveryTransportError>;
  }
>()("t3code-relay/agentActivity/WebPushDeliveries") {}

function unavailableDelivery(
  subscriptionId: string,
  reason = "anonymous_pwa_unavailable",
): RelayDeliveryResult {
  return {
    deviceId: subscriptionId,
    kind: "web_push_notification",
    ok: false,
    queued: false,
    apnsStatus: null,
    apnsReason: null,
    apnsId: null,
    webPushReason: reason,
  };
}

const validEndpoint = Schema.is(RelayWebPushSubscriptionRegistrationRequest.fields.endpoint);
const validKeys = Schema.is(RelayWebPushSubscriptionRegistrationRequest.fields.keys);
const decodePreferences = Schema.decodeUnknownOption(RelayWebPushPreferences);

function currentOwnership(
  subscription: WebPushSubscriptions.WebPushNotification["subscription"],
  anonymousAllowed: boolean,
): "account" | "anonymous" | null {
  if (
    subscription.environmentId === null &&
    subscription.installationId === null &&
    subscription.installationSecretHash === null
  ) {
    return subscription.userId.startsWith("pwa:") ? null : "account";
  }
  return anonymousAllowed &&
    subscription.environmentId !== null &&
    subscription.installationId !== null &&
    subscription.installationSecretHash !== null &&
    subscription.userId === `pwa:${subscription.installationId}`
    ? "anonymous"
    : null;
}

const anonymousBodies = {
  plan_ready: "An agent has a plan ready.",
  input_required: "An agent needs your attention.",
  agent_completed: "An agent completed.",
  agent_failed: "An agent failed.",
};

const decodeSignedJob = Schema.decodeUnknownEffect(SignedWebPushDeliveryJob);

export const make = Effect.gen(function* () {
  const anonymousAllowed = yield* anonymousPwaAllowed;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const webCrypto = yield* WebCrypto.WebCrypto;
  const subscriptions = yield* WebPushSubscriptions.WebPushSubscriptions;
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const activityRows = yield* AgentActivityRows.AgentActivityRows;
  if (!config.webPush) {
    return yield* Effect.die("Web Push VAPID credentials are not configured.");
  }
  const vapidDetails = {
    subject: config.webPush.subject,
    publicKey: config.webPush.publicKey,
    privateKey: Redacted.value(config.webPush.privateKey),
  };

  const send = Effect.fn("relay.web_push_deliveries.send")(function* (input: {
    readonly subscription: WebPushSubscriptions.WebPushNotification["subscription"];
    readonly payload: WebPushPayload;
  }) {
    if (blocksWebPushDelivery(input.subscription, anonymousAllowed)) {
      return unavailableDelivery(input.subscription.id);
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          webpush.sendNotification(
            {
              endpoint: input.subscription.endpoint,
              keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth },
            },
            WebPushPayloadJson(input.payload),
            { TTL: 60, vapidDetails },
          ),
        catch: (cause) => new WebPushDeliveryTransportError({ cause }),
      }),
    );
    if (Result.isSuccess(result)) {
      return {
        deviceId: input.subscription.id,
        kind: "web_push_notification" as const,
        ok: true,
        queued: false,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
        webPushStatus: result.success.statusCode,
        webPushReason: null,
      };
    }
    const status = responseStatus(result.failure.cause);
    if (status === 404 || status === 410) {
      yield* subscriptions
        .removeIfCurrent({
          userId: input.subscription.userId,
          subscriptionId: input.subscription.id,
          subscriptionIncarnationId: input.subscription.incarnationId,
        })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      return {
        deviceId: input.subscription.id,
        kind: "web_push_notification" as const,
        ok: false,
        queued: false,
        apnsStatus: null,
        apnsReason: null,
        apnsId: null,
        webPushStatus: status,
        webPushReason: "subscription_gone",
      };
    }
    return yield* result.failure;
  });
  return WebPushDeliveries.of({
    send,
    processSignedJob: Effect.fn("relay.web_push_deliveries.process_signed_job")(function* (body) {
      const decoded = yield* Effect.result(decodeSignedJob(body));
      if (Result.isFailure(decoded)) return unavailableDelivery("", "invalid_job");
      const job = decoded.success;
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const verified = yield* verifyWebPushDeliveryJob({
        secret: config.webPushDeliveryJobSigningSecret ?? config.apnsDeliveryJobSigningSecret,
        job,
        nowMs,
      }).pipe(
        Effect.provideService(WebCrypto.WebCrypto, webCrypto),
        Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })),
      );
      if (verified === null) return unavailableDelivery("", "invalid_job");
      // Only authenticated fields may govern deployment policy or persistence.
      if (verified.version === 1 && !anonymousAllowed) {
        return unavailableDelivery(verified.subscriptionId, "v1_unavailable");
      }
      if (!anonymousAllowed && verified.userId.startsWith("pwa:")) {
        return unavailableDelivery(verified.subscriptionId);
      }
      const subscription = yield* subscriptions
        .get({ userId: verified.userId, subscriptionId: verified.subscriptionId })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      if (subscription === null)
        return unavailableDelivery(verified.subscriptionId, "subscription_missing");
      if (
        subscription.userId !== verified.userId ||
        subscription.id !== verified.subscriptionId ||
        blocksWebPushDelivery(subscription, anonymousAllowed)
      ) {
        return unavailableDelivery(verified.subscriptionId, "subscription_unavailable");
      }
      let payload: WebPushPayload;
      let environmentId: string | null = null;
      let threadId: string | null = null;
      if (verified.version === 1) {
        // Historical bytes have no source/incarnation provenance. Keep legacy queued copy.
        payload = verified;
      } else {
        const ownership = currentOwnership(subscription, anonymousAllowed);
        if (
          ownership === null ||
          subscription.incarnationId !== verified.subscriptionIncarnationId ||
          !validEndpoint(subscription.endpoint) ||
          !validKeys({ p256dh: subscription.p256dh, auth: subscription.auth })
        ) {
          return unavailableDelivery(verified.subscriptionId, "subscription_unavailable");
        }
        if (verified.kind === "test") {
          payload = {
            eventId: `${ownership === "account" ? "web-push-test" : "pwa-web-push-test"}:${subscription.id}`,
            title: "Arcwright Code",
            body: "Your PWA push notifications are working.",
            deepLink: "/",
            showProjectAndThreadNames: false,
          };
        } else {
          const preferences = decodePreferences(subscription.preferencesJson);
          if (
            Option.isNone(preferences) ||
            !wantsNotification(preferences.value, verified.provenance.notificationKind)
          ) {
            return unavailableDelivery(verified.subscriptionId, "preferences_unavailable");
          }
          const source = verified.provenance;
          if (ownership === "anonymous") {
            // Legacy anonymous rows have no current source-key/account-state projection.
            const expiresAt = agentActivityExpiresAt(source.stateVersion);
            if (
              source.linkIncarnationId !== null ||
              subscription.environmentId !== source.environmentId ||
              !kindFitsState(source.notificationKind, source.stateVersion) ||
              !Number.isFinite(expiresAt) ||
              nowMs > expiresAt
            ) {
              return unavailableDelivery(verified.subscriptionId, "activity_unavailable");
            }
            payload = {
              eventId: verified.eventId,
              title: "Arcwright Code",
              body: anonymousBodies[source.notificationKind],
              deepLink: "/",
              showProjectAndThreadNames: false,
            };
          } else {
            if (source.linkIncarnationId === null)
              return unavailableDelivery(verified.subscriptionId, "activity_unavailable");
            const current = yield* activityRows
              .getForNotification({
                userId: verified.userId,
                environmentId: source.environmentId,
                environmentPublicKey: source.environmentPublicKey,
                threadId: source.threadId,
                linkIncarnationId: source.linkIncarnationId,
              })
              .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
            if (
              current === null ||
              current.environmentId !== source.environmentId ||
              current.threadId !== source.threadId
            )
              return unavailableDelivery(verified.subscriptionId, "activity_unavailable");
            const currentVersion = stateVersion(current);
            if (
              currentVersion.updatedAt !== source.stateVersion.updatedAt ||
              currentVersion.phase !== source.stateVersion.phase ||
              currentVersion.hasActionableProposedPlan !==
                source.stateVersion.hasActionableProposedPlan ||
              !kindFitsState(source.notificationKind, currentVersion) ||
              isExpiredAgentActivityState(current, nowMs)
            ) {
              return unavailableDelivery(verified.subscriptionId, "activity_unavailable");
            }
            const names =
              verified.showProjectAndThreadNames && preferences.value.showProjectAndThreadNames;
            payload = {
              eventId: verified.eventId,
              deepLink: current.deepLink,
              showProjectAndThreadNames: names,
              ...notificationCopy({ state: current, kind: source.notificationKind, names }),
            };
          }
          environmentId = source.environmentId;
          threadId = source.threadId;
        }
      }
      // A denied job never touches the attempt lifecycle. The optional native
      // capability is required only for an admitted Web Push attempt.
      const releaseSourceJob = attempts.releaseSourceJob;
      if (!releaseSourceJob)
        return yield* new WebPushDeliveryTransportError({
          cause: "Web Push claim release is unavailable.",
        });
      const claim = yield* attempts
        .claimSourceJob({
          userId: verified.userId,
          environmentId,
          threadId,
          deviceId: verified.subscriptionId,
          kind: "web_push_notification",
          sourceJobId: verified.jobId,
          token: null,
        })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      if (claim === "completed")
        return unavailableDelivery(verified.subscriptionId, "duplicate_job");
      if (claim === "in_flight")
        return yield* new WebPushDeliveryTransportError({
          cause: "Web Push delivery job is already in flight.",
        });
      // No post-network authorization check: this lifecycle belongs to the
      // admitted attempt. Later changes are checked afresh on every retry.
      const result = yield* send({ subscription, payload }).pipe(
        Effect.tapError(() =>
          releaseSourceJob({ sourceJobId: verified.jobId }).pipe(
            Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })),
          ),
        ),
      );
      yield* attempts
        .completeSourceJob({
          sourceJobId: verified.jobId,
          ...(typeof result.webPushStatus === "number" ? { apnsStatus: result.webPushStatus } : {}),
          ...(result.webPushReason ? { apnsReason: result.webPushReason } : {}),
        })
        .pipe(Effect.mapError((cause) => new WebPushDeliveryTransportError({ cause })));
      return result;
    }),
  });
});

export const layer = Layer.effect(WebPushDeliveries, make);
