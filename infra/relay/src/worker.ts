import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpMiddleware from "effect/http/HttpMiddleware";

import { pwaApi } from "./http/Api.ts";
import * as PublicRelayRateLimits from "./http/PublicRelayRateLimits.ts";
import {
  assemblePublicRelayHttp,
  withCloudflarePublicRelayIdentity,
} from "./http/PublicRelayBoundary.ts";
import * as RelayHttpApi from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { RelayObservability } from "./observability.ts";
import { relayRuntimeTokenModeConfig } from "./deploymentOptions.ts";
import { existingRuntimeCloudflareClients } from "./runtimeCloudflareAuth.ts";
import * as Observability from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { runtimePostgres } from "./runtimePostgres.ts";
import {
  RelayApnsDeliveryDeadLetterQueue,
  RelayApnsDeliveryQueue,
  RelayWebPushDeliveryDeadLetterQueue,
  RelayWebPushDeliveryQueue,
  RelayFcmDeliveryQueue,
  RelayFcmDeliveryDeadLetterQueue,
} from "./queues.ts";
import * as WebCrypto from "./WebCrypto.ts";
import * as FcmAssertionSigner from "./agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "./agentActivity/FcmClient.ts";
import * as FcmDeliveryQueueSender from "./agentActivity/FcmDeliveryQueueSender.ts";
import * as FcmDeliveries from "./agentActivity/FcmDeliveries.ts";
import * as FcmDeliveryQueueConsumer from "./agentActivity/FcmDeliveryQueueConsumer.ts";
import * as RelayConfiguration from "./Config.ts";
import { loadWorkerClerkAuthPolicy } from "./workerAuthPolicy.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as CloudflareApiPause from "./environments/CloudflareApiPause.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointLifecycle from "./environments/ManagedEndpointLifecycle.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedEndpointReaper from "./environments/ManagedEndpointReaper.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import * as WebPushRuntime from "./agentActivity/webPushRuntime.ts";
import * as WebPushDeliveries from "./agentActivity/WebPushDeliveries.ts";
import * as WebPushDeliveryQueue from "./agentActivity/WebPushDeliveryQueue.ts";
import * as HookForwarder from "./hooks/HookForwarder.ts";
import * as HeldHooks from "./hooks/HeldHooks.ts";
import * as HookInbox from "./hooks/HookInbox.ts";
import * as HookInboxObject from "./hooks/HookInboxObject.ts";

const layerWebcrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const layerRelayApi = Layer.mergeAll(
  RelayHttpApi.layerHealthApi,
  RelayHttpApi.layerMetadataApi,
  RelayHttpApi.layerMobileApi,
  RelayHttpApi.layerClientApi,
  RelayHttpApi.layerTokenApi,
  RelayHttpApi.layerDpopClientApi,
  RelayHttpApi.layerServerApi,
  pwaApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});
const WebPushDeliveryJobSigningSecret = Alchemy.makeRandom("WebPushDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const layer = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const webPushDeliveryQueue = yield* RelayWebPushDeliveryQueue;
    const webPushDeliveryDeadLetterQueue = yield* RelayWebPushDeliveryDeadLetterQueue;
    const fcmDeliveryQueue = yield* RelayFcmDeliveryQueue;
    const fcmDeliveryDeadLetterQueue = yield* RelayFcmDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const randomWebPushDeliveryJobSigningSecret = yield* WebPushDeliveryJobSigningSecret;

    const apnsEnabled = yield* Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true));
    const apnsCredentials = apnsEnabled
      ? {
          environment: yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
          teamId: yield* Config.String("APNS_TEAM_ID"),
          keyId: yield* Config.String("APNS_KEY_ID"),
          bundleId: yield* Config.String("APNS_BUNDLE_ID"),
          privateKey: yield* Config.Redacted("APNS_PRIVATE_KEY"),
        }
      : null;
    const fcmServiceAccount = Option.getOrUndefined(
      Option.filter(
        yield* Config.option(Config.Redacted("FCM_SERVICE_ACCOUNT")),
        (value) => Redacted.value(value).trim().length > 0,
      ),
    );
    const webPushVapidSubject = yield* Config.String("WEB_PUSH_VAPID_SUBJECT");
    const webPushVapidPublicKey = yield* Config.String("WEB_PUSH_VAPID_PUBLIC_KEY");
    const webPushVapidPrivateKey = yield* Config.Redacted("WEB_PUSH_VAPID_PRIVATE_KEY");
    const webPushDeliveryJobSigningSecret = yield* randomWebPushDeliveryJobSigningSecret;
    const webPushDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(webPushDeliveryQueue);
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);
    const fcmDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(fcmDeliveryQueue);

    const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.String("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.String("CLERK_JWT_AUDIENCE");
    const clerkAuthPolicy = yield* loadWorkerClerkAuthPolicy;

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* RelayDb.connectRelayHyperdrive;
    // Named prepared statements collide behind Hyperdrive's transaction-mode
    // pool: sql-pg < 4.0.0-rc.117 names them `effect1..N` per connection, and
    // inside a transaction a Bind can reach another request's statement
    // (#14070, Effect-TS/effect#8320). Unnamed statements cannot collide.
    const db = yield* runtimePostgres(hyperdrive.connectionString);

    const existingClients =
      (yield* relayRuntimeTokenModeConfig) === "existing"
        ? yield* existingRuntimeCloudflareClients(yield* managedEndpointZone.zoneId)
        : null;
    const managedEndpointTunnelBinding = existingClients
      ? existingClients.tunnels
      : yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = existingClients
      ? existingClients.dns
      : yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;
    const managedEndpointCleanupMode = yield* RelayConfiguration.managedEndpointCleanupModeConfig;
    const legacyManagedEndpointCleanupMode =
      yield* RelayConfiguration.legacyManagedEndpointCleanupModeConfig;
    const legacyTunnelGraceMinutes = Option.getOrUndefined(
      yield* RelayConfiguration.legacyTunnelGraceMinutesConfig,
    );
    // Keys are endpoint keys or hashes over them, which already differ per
    // stage, so stages sharing an account cannot collide in these namespaces.
    const hookRateLimit = yield* Cloudflare.RateLimit("HOOK_RATE_LIMIT", {
      namespaceId: 1001,
      simple: {
        limit: HookForwarder.RELAY_HOOK_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_RATE_LIMIT.periodSeconds,
      },
    });
    const hookEndpointRateLimit = yield* Cloudflare.RateLimit("HOOK_ENDPOINT_RATE_LIMIT", {
      namespaceId: 1002,
      simple: {
        limit: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.limit,
        period: HookForwarder.RELAY_HOOK_ENDPOINT_RATE_LIMIT.periodSeconds,
      },
    });
    const public30 = yield* Cloudflare.RateLimit("PUBLIC_RELAY_30", {
      namespaceId: 1101,
      simple: { limit: 30, period: 60 },
    });
    const public120 = yield* Cloudflare.RateLimit("PUBLIC_RELAY_120", {
      namespaceId: 1102,
      simple: { limit: 120, period: 60 },
    });
    const public240 = yield* Cloudflare.RateLimit("PUBLIC_RELAY_240", {
      namespaceId: 1103,
      simple: { limit: 240, period: 60 },
    });
    const public60 = yield* Cloudflare.RateLimit("PUBLIC_RELAY_60", {
      namespaceId: 1104,
      simple: { limit: 60, period: 60 },
    });
    const public10 = yield* Cloudflare.RateLimit("PUBLIC_RELAY_10", {
      namespaceId: 1105,
      simple: { limit: 10, period: 60 },
    });
    const publicEdge = yield* Cloudflare.RateLimit("PUBLIC_RELAY_EDGE", {
      namespaceId: 1106,
      simple: { limit: 120, period: 60 },
    });
    const hookInboxes = yield* HookInboxObject.HookInboxObject;

    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      const settings = RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        ...(fcmServiceAccount ? { fcmServiceAccount } : {}),
        apns: apnsCredentials,
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        webPushDeliveryJobSigningSecret: yield* webPushDeliveryJobSigningSecret,
        webPush: {
          subject: webPushVapidSubject,
          publicKey: webPushVapidPublicKey,
          privateKey: webPushVapidPrivateKey,
        },
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        clerkAuthPolicy,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
        managedEndpointCleanupMode,
        legacyManagedEndpointCleanupMode,
        ...(legacyTunnelGraceMinutes === undefined ? {} : { legacyTunnelGraceMinutes }),
      });
      yield* RelayConfiguration.resolveClerkAuthPolicy(settings);
      return settings;
    });

    const inboxCall =
      <A>(operation: HookInbox.HookInboxError["operation"], endpointKey: string) =>
      (effect: Effect.Effect<A, never, Alchemy.RuntimeContext>) =>
        effect.pipe(
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catchCause((cause) =>
            Effect.fail(
              new HookInbox.HookInboxError({
                operation,
                endpointKey,
                cause: Cause.squash(cause),
              }),
            ),
          ),
        );
    const layerHookInbox = Layer.succeed(HookInbox.HookInbox, {
      hold: ({ endpointKey, baseUrl, hook }) =>
        hookInboxes.getByName(endpointKey).hold(hook, baseUrl).pipe(inboxCall("hold", endpointKey)),
      wake: ({ endpointKey, baseUrl }) =>
        hookInboxes.getByName(endpointKey).wake(baseUrl).pipe(inboxCall("wake", endpointKey)),
      clear: ({ endpointKey }) =>
        hookInboxes.getByName(endpointKey).clear().pipe(inboxCall("clear", endpointKey)),
    });

    const layerRuntimeBase = Layer.empty.pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(WebPushRuntime.layer),
      Layer.provideMerge(
        WebPushDeliveryQueue.layerCloudflareQueues(
          webPushDeliveryQueueSender,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentPublishSignatures.layer,
          ManagedEndpointReaper.layer,
          HeldHooks.layer,
        ),
      ),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(ManagedEndpointLifecycle.layer),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(
        FcmDeliveries.layer.pipe(
          Layer.provide(
            Layer.succeed(FcmDeliveryQueueSender.FcmDeliveryQueueSender, {
              send: (body) =>
                fcmDeliveryQueueSender
                  .send(body)
                  .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
            }),
          ),
          Layer.provideMerge(FcmClient.layer.pipe(Layer.provide(FcmAssertionSigner.layer))),
        ),
      ),
    );
    const layerRuntime = layerRuntimeBase.pipe(
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(Layer.mergeAll(AgentActivityRows.layer, Devices.layer, layerHookInbox)),
      Layer.provideMerge(Layer.merge(EnvironmentCredentials.layer, LiveActivities.layer)),
      Layer.provideMerge(
        Layer.mergeAll(
          CloudflareApiPause.layer,
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
        ),
      ),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(
          Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        ),
      ),
      Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
      Layer.provideMerge(
        Layer.merge(
          layerWebcrypto,
          Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
        ),
      ),
    );

    // Fails open: a limiter outage must not drop webhooks the environment would accept.
    const allowWith =
      (limiter: typeof hookRateLimit) =>
      (key: string): Effect.Effect<boolean> =>
        limiter.limit({ key }).pipe(
          Effect.map((result) => result.success),
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          Effect.catch((error) =>
            Effect.logWarning("Hook rate limiter unavailable", { error: error.message }).pipe(
              Effect.andThen(
                Effect.annotateCurrentSpan({ "relay.hook.rate_limiter_failed_open": true }),
              ),
              Effect.as(true),
            ),
          ),
        );
    const layerHookRateLimiter = Layer.succeed(HookForwarder.HookRateLimiter, {
      allowHook: allowWith(hookRateLimit),
      allowEndpoint: allowWith(hookEndpointRateLimit),
    });

    const layerApp = Layer.merge(
      layerRelayApi,
      HookForwarder.layerApi.pipe(
        Layer.provide(HookForwarder.layer),
        Layer.provide(layerHookRateLimiter),
      ),
    ).pipe(
      Layer.provideMerge(RelayHttpApi.layerClientAuth),
      Layer.provideMerge(RelayHttpApi.layerDpopClientAuth),
      Layer.provideMerge(RelayHttpApi.layerEnvironmentAuth),
      Layer.provide(layerRuntime),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      webPushDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: webPushDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.web_push_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            WebPushDeliveries.WebPushDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.web_push_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      fcmDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "1 second",
        retryDelay: "30 seconds",
        deadLetterQueue: fcmDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.fcm_delivery_queue.process_batch"),
          Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
          Effect.provide(layerRuntime),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      Effect.all(
        [
          DpopProofs.DpopProofReplay.pipe(
            Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
            Effect.andThen(
              Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
                Effect.flatMap(([activityRows, now]) =>
                  activityRows.pruneTerminal({
                    updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
                  }),
                ),
              ),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to prune expired relay state", { cause }),
            ),
          ),
          ManagedEndpointReaper.ManagedEndpointReaper.pipe(
            Effect.flatMap((reaper) => reaper.sweep.pipe(Effect.timeout("2 minutes"))),
            Effect.tap((result) =>
              result.scanned > 0
                ? Effect.logInfo("Finished managed tunnel cleanup", result)
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to clean up inactive managed tunnels", { cause }),
            ),
          ),
          AgentActivityPublisher.AgentActivityPublisher.pipe(
            Effect.flatMap((publisher) => publisher.endIdleLiveActivities),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to end idle Live Activities", { cause }),
            ),
          ),
        ],
        { concurrency: 3, discard: true },
      ).pipe(
        Effect.withSpan("relay.cron.prune_expired_state"),
        Observability.withSchemaErrorSpanAttributes,
        Effect.provide(layerRuntime),
      ),
    );

    const configuredPublicBinding = (binding: typeof public30) => ({
      limit: (options: { readonly key: string }) =>
        binding
          .limit(options)
          .pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
    });
    const publicLimiterLayer = PublicRelayRateLimits.layerCloudflare(
      { issuer: relayPublicOrigin, stage },
      {
        30: configuredPublicBinding(public30),
        120: configuredPublicBinding(public120),
        240: configuredPublicBinding(public240),
        60: configuredPublicBinding(public60),
        10: configuredPublicBinding(public10),
        edge: configuredPublicBinding(publicEdge),
      },
    );
    const fetch = assemblePublicRelayHttp(layerApp, publicLimiterLayer).pipe(
      Effect.map((httpEffect) =>
        withCloudflarePublicRelayIdentity(httpEffect).pipe(
          Observability.withSchemaErrorSpanAttributes,
        ),
      ),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
        Layer.provideMerge(Cloudflare.Workers.RateLimitBinding),
        Layer.provideMerge(HookInboxObject.layer),
        // The worker runtime opens its own HTTP span around ours. Ours carries
        // the route, header redaction and webhook URL redaction, and drops a
        // webhook sender's traceparent, so the runtime's span is off for every
        // request rather than duplicating it.
        Layer.provideMerge(
          Alchemy.Telemetry.layer(Layer.succeed(HttpMiddleware.TracerDisabledWhen)(() => true)),
        ),
        Layer.provideMerge(
          Layer.unwrap(
            Effect.map(RelayObservability, (observability) =>
              observability === null
                ? Layer.empty
                : Axiom.Telemetry({
                    serviceName: "t3code-relay",
                    token: observability.workerIngestToken,
                    traces: observability.traces,
                  }),
            ),
          ),
        ),
      ),
    ),
  ),
);

export default layer;
