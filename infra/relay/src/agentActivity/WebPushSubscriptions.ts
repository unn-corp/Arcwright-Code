import type {
  RelayAgentActivityState,
  RelayPwaWebPushSubscriptionRegistrationRequest,
  RelayWebPushSubscriptionRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, lt, or, sql } from "drizzle-orm";

import * as PublicLimits from "../http/PublicRelayRateLimits.ts";
import * as RelayDb from "../db.ts";
import {
  AnonymousPwaUnavailable,
  anonymousPwaAllowed,
  hasAnonymousOwnership,
  blocksWebPushDelivery,
} from "./anonymousPwaPolicy.ts";
import {
  relayWebPushSubscriptions,
  relayWebPushSubscriptionStates,
} from "../persistence/schema.ts";

import {
  notificationKind,
  notificationCopy,
  wantsNotification,
  stateVersion,
} from "./webPushNotifications.ts";

import type { WebPushNotificationKind, WebPushActivityPayloadV2 } from "./webPushDeliveryJobs.ts";

export type WebPushNotification = {
  readonly notificationKind: WebPushNotificationKind;
  readonly source: Omit<
    WebPushActivityPayloadV2["provenance"],
    "environmentPublicKey" | "linkIncarnationId"
  >;
  readonly eventId: string;
  readonly deepLink: string;
  readonly showProjectAndThreadNames: boolean;
  readonly title: string;
  readonly body: string;
  readonly subscription: typeof relayWebPushSubscriptions.$inferSelect;
};

export class WebPushSubscriptionPersistenceError extends Schema.TaggedError<WebPushSubscriptionPersistenceError>()(
  "WebPushSubscriptionPersistenceError",
  { cause: Schema.Defect() },
) {}

type PublicAdmissionError =
  | PublicLimits.PublicRelayRateLimited
  | PublicLimits.PublicRelayLimiterUnavailable;
const isPublicAdmissionError = Schema.is(
  Schema.Union([PublicLimits.PublicRelayRateLimited, PublicLimits.PublicRelayLimiterUnavailable]),
);

export type WebPushSubscriptionError =
  | WebPushSubscriptionPersistenceError
  | AnonymousPwaUnavailable;

function mapPersistenceError<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.mapError((cause) => new WebPushSubscriptionPersistenceError({ cause })),
  );
}

const isAnonymousPwaUnavailable = Schema.is(AnonymousPwaUnavailable);

function mapPwaAccessError<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.mapError((cause): WebPushSubscriptionError | Extract<E, PublicAdmissionError> =>
      isAnonymousPwaUnavailable(cause)
        ? cause
        : isPublicAdmissionError(cause)
          ? (cause as Extract<E, PublicAdmissionError>)
          : new WebPushSubscriptionPersistenceError({ cause }),
    ),
  );
}

type PwaRegistrationInput = { readonly payload: RelayPwaWebPushSubscriptionRegistrationRequest };
type PwaCredentialInput = {
  readonly installationId: string;
  readonly installationSecret: string;
  readonly subscriptionId: string;
};

export class WebPushSubscriptions extends Context.Service<
  WebPushSubscriptions,
  {
    readonly register: (input: {
      readonly userId: string;
      readonly payload: RelayWebPushSubscriptionRegistrationRequest;
    }) => Effect.Effect<{ readonly subscriptionId: string }, WebPushSubscriptionPersistenceError>;
    readonly remove: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<boolean, WebPushSubscriptionPersistenceError>;
    readonly removeIfCurrent: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
      readonly subscriptionIncarnationId: string;
    }) => Effect.Effect<boolean, WebPushSubscriptionPersistenceError>;
    readonly get: (input: {
      readonly userId: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<
      typeof relayWebPushSubscriptions.$inferSelect | null,
      WebPushSubscriptionPersistenceError
    >;
    readonly transition: (input: {
      readonly userId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ReadonlyArray<WebPushNotification>, WebPushSubscriptionPersistenceError>;
    readonly registerPwa: (input: {
      readonly payload: RelayPwaWebPushSubscriptionRegistrationRequest;
    }) => Effect.Effect<{ readonly subscriptionId: string }, WebPushSubscriptionError>;
    readonly registerPwaPublic: (
      input: PwaRegistrationInput,
    ) => Effect.Effect<
      { readonly subscriptionId: string },
      WebPushSubscriptionError | PublicAdmissionError,
      PublicLimits.PublicRelayRateLimits
    >;
    readonly removePwaPublic: (
      input: PwaCredentialInput,
    ) => Effect.Effect<
      boolean,
      WebPushSubscriptionPersistenceError | PublicAdmissionError,
      PublicLimits.PublicRelayRateLimits
    >;
    readonly getPwaForCleanup: (
      input: PwaCredentialInput,
    ) => Effect.Effect<
      typeof relayWebPushSubscriptions.$inferSelect | null,
      WebPushSubscriptionPersistenceError
    >;
    readonly removePwa: (input: {
      readonly installationId: string;
      readonly installationSecret: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<boolean, WebPushSubscriptionPersistenceError>;
    readonly getPwa: (input: {
      readonly installationId: string;
      readonly installationSecret: string;
      readonly subscriptionId: string;
    }) => Effect.Effect<
      typeof relayWebPushSubscriptions.$inferSelect | null,
      WebPushSubscriptionError
    >;
    readonly transitionEnvironment: (input: {
      readonly environmentId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<ReadonlyArray<WebPushNotification>, WebPushSubscriptionPersistenceError>;
  }
>()("t3code-relay/agentActivity/WebPushSubscriptions") {}

function hashInstallationSecret(crypto: Crypto.Crypto, secret: string) {
  return Effect.gen(function* () {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(secret));
    return Base64Url.encode(digest);
  });
}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const anonymousAllowed = yield* anonymousPwaAllowed;
  const getPwaForCleanup: WebPushSubscriptions["Service"]["getPwaForCleanup"] = (input) =>
    Effect.gen(function* () {
      const installationSecretHash = yield* hashInstallationSecret(
        crypto,
        input.installationSecret,
      );
      const [row] = yield* db
        .select()
        .from(relayWebPushSubscriptions)
        .where(
          and(
            eq(relayWebPushSubscriptions.id, input.subscriptionId),
            eq(relayWebPushSubscriptions.installationId, input.installationId),
            eq(relayWebPushSubscriptions.userId, `pwa:${input.installationId}`),
            eq(relayWebPushSubscriptions.installationSecretHash, installationSecretHash),
          ),
        )
        .limit(1);
      return row ?? null;
    }).pipe(mapPersistenceError);
  const removePwa = <E, R>(
    input: PwaCredentialInput,
    admit: (row: typeof relayWebPushSubscriptions.$inferSelect) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      const observed = yield* getPwaForCleanup(input);
      if (!observed) return false;
      // Public admission is outside the SQL transaction. Removal never gains authority over a replacement.
      yield* admit(observed);
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            yield* db.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web-push:installation:${input.installationId}`}, 0))`,
            );
            const deleted = yield* db
              .delete(relayWebPushSubscriptions)
              .where(
                and(
                  eq(relayWebPushSubscriptions.id, observed.id),
                  eq(relayWebPushSubscriptions.incarnationId, observed.incarnationId),
                  eq(relayWebPushSubscriptions.userId, observed.userId),
                  eq(relayWebPushSubscriptions.installationId, input.installationId),
                  eq(
                    relayWebPushSubscriptions.installationSecretHash,
                    observed.installationSecretHash!,
                  ),
                ),
              )
              .returning({ id: relayWebPushSubscriptions.id });
            if (deleted.length === 0) return false;
            yield* db
              .delete(relayWebPushSubscriptionStates)
              .where(eq(relayWebPushSubscriptionStates.subscriptionId, observed.id));
            return true;
          }),
        )
        .pipe(mapPersistenceError);
    });
  const registerPwa = <E, R>(
    input: PwaRegistrationInput,
    admitRenewal: (row: typeof relayWebPushSubscriptions.$inferSelect) => Effect.Effect<void, E, R>,
    registrationPath: "internal" | "public",
  ) =>
    Effect.gen(function* () {
      if (!anonymousAllowed) return yield* new AnonymousPwaUnavailable();
      const now = DateTime.formatIso(yield* DateTime.now);
      const installation = input.payload.installation;
      const installationSecretHash = yield* hashInstallationSecret(
        crypto,
        installation.installationSecret,
      );
      const [observed] = yield* db
        .select()
        .from(relayWebPushSubscriptions)
        .where(eq(relayWebPushSubscriptions.installationId, installation.installationId))
        .limit(1);
      if (observed) {
        if (
          observed.installationSecretHash !== installationSecretHash ||
          observed.userId !== `pwa:${installation.installationId}`
        ) {
          return yield* new WebPushSubscriptionPersistenceError({
            cause: "installation_credential_mismatch",
          });
        }
        yield* admitRenewal(observed);
      }
      const id = yield* crypto.randomUUIDv4;
      const values = {
        id,
        userId: `pwa:${installation.installationId}`,
        environmentId: input.payload.environmentId,
        installationId: installation.installationId,
        installationSecretHash,
        endpoint: input.payload.endpoint,
        p256dh: input.payload.keys.p256dh,
        auth: input.payload.keys.auth,
        preferencesJson: input.payload.preferences,
        createdAt: now,
        updatedAt: now,
      };
      return yield* db.$client.withTransaction(
        Effect.gen(function* () {
          // Endpoint transfers delete the old row. Serialize the two stable
          // identities as well as locking existing rows, so a waiting transfer
          // cannot continue from a row deleted after its SELECT snapshot.
          for (const identity of [
            `web-push:endpoint:${values.endpoint}`,
            `web-push:installation:${values.installationId}`,
          ].sort()) {
            yield* db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
          }
          // Establish the unique installation/endpoint before the locked read,
          // including concurrent first registrations. A rejected credential or
          // failed baseline cleanup rolls this insertion back too.
          const insert = db.insert(relayWebPushSubscriptions).values(values).onConflictDoNothing();
          const created =
            registrationPath === "public"
              ? yield* insert.returning({ id: relayWebPushSubscriptions.id })
              : yield* insert.pipe(Effect.as([]));
          const owners = yield* db
            .select()
            .from(relayWebPushSubscriptions)
            .where(
              or(
                eq(relayWebPushSubscriptions.installationId, installation.installationId),
                eq(relayWebPushSubscriptions.endpoint, input.payload.endpoint),
              ),
            )
            .orderBy(relayWebPushSubscriptions.id)
            .for("update");
          const existing = owners.find((row) => row.installationId === installation.installationId);
          // An edge-only public first registration cannot renew a concurrent
          // winner. A later request must authenticate and admit that installation.
          // A conflict only on another installation's endpoint can still transfer
          // it below, creating this request's own row under the same locks.
          if (
            registrationPath === "public" &&
            !observed &&
            existing &&
            !created.some((row) => row.id === values.id && row.id === existing.id)
          ) {
            return yield* new WebPushSubscriptionPersistenceError({
              cause: "installation_ownership_changed",
            });
          }
          if (
            observed &&
            (!existing ||
              existing.id !== observed.id ||
              existing.incarnationId !== observed.incarnationId ||
              existing.userId !== observed.userId)
          ) {
            return yield* new WebPushSubscriptionPersistenceError({
              cause: "installation_ownership_changed",
            });
          }
          if (existing && existing.installationSecretHash !== installationSecretHash) {
            return yield* new WebPushSubscriptionPersistenceError({
              cause: "installation_credential_mismatch",
            });
          }
          const endpointOwner = owners.find((row) => row.endpoint === input.payload.endpoint);
          // A retained endpoint may transfer to a new authenticated installation.
          // Lock both rows in id order before removing the previous ownership.
          if (endpointOwner && endpointOwner.id !== existing?.id) {
            yield* db
              .delete(relayWebPushSubscriptionStates)
              .where(eq(relayWebPushSubscriptionStates.subscriptionId, endpointOwner.id));
            yield* db
              .delete(relayWebPushSubscriptions)
              .where(eq(relayWebPushSubscriptions.id, endpointOwner.id));
          }
          const rotatesIncarnation = sql`${relayWebPushSubscriptions.userId} IS DISTINCT FROM ${values.userId}
              OR ${relayWebPushSubscriptions.environmentId} IS DISTINCT FROM ${values.environmentId}
              OR ${relayWebPushSubscriptions.installationId} IS DISTINCT FROM ${values.installationId}
              OR ${relayWebPushSubscriptions.installationSecretHash} IS DISTINCT FROM ${installationSecretHash}
              OR ${relayWebPushSubscriptions.endpoint} IS DISTINCT FROM ${values.endpoint}
              OR ${relayWebPushSubscriptions.p256dh} IS DISTINCT FROM ${values.p256dh}
              OR ${relayWebPushSubscriptions.auth} IS DISTINCT FROM ${values.auth}`;
          const rows = yield* db
            .insert(relayWebPushSubscriptions)
            .values(values)
            .onConflictDoUpdate({
              target: relayWebPushSubscriptions.installationId,
              set: {
                userId: values.userId,
                environmentId: values.environmentId,
                installationSecretHash,
                endpoint: values.endpoint,
                p256dh: values.p256dh,
                auth: values.auth,
                preferencesJson: values.preferencesJson,
                updatedAt: now,
                incarnationId: sql`CASE WHEN ${rotatesIncarnation} THEN gen_random_uuid()
                    ELSE ${relayWebPushSubscriptions.incarnationId} END`,
              },
            })
            .returning({ id: relayWebPushSubscriptions.id });
          const row = rows[0];
          if (!row)
            return yield* new WebPushSubscriptionPersistenceError({
              cause: "subscription_missing_after_registration",
            });
          if (registrationPath === "public" && !observed && row.id !== values.id)
            return yield* new WebPushSubscriptionPersistenceError({
              cause: "installation_ownership_changed",
            });
          return { subscriptionId: row.id };
        }),
      );
    }).pipe(mapPwaAccessError, Effect.withSpan("relay.web_push_subscriptions.register_pwa"));

  return WebPushSubscriptions.of({
    registerPwa: (input) => registerPwa(input, () => Effect.void, "internal"),
    registerPwaPublic: (input) =>
      registerPwa(
        input,
        (row) =>
          PublicLimits.PublicRelayRateLimits.pipe(
            Effect.flatMap((limiter) =>
              limiter.admit("registerPwaWebPushSubscription", {
                kind: "installation",
                installationId: row.installationId!,
              }),
            ),
          ),
        "public",
      ),
    removePwa: (input) => removePwa(input, () => Effect.void),
    removePwaPublic: (input) =>
      removePwa(input, (row) =>
        PublicLimits.PublicRelayRateLimits.pipe(
          Effect.flatMap((limiter) =>
            limiter.admit("removePwaWebPushSubscription", {
              kind: "installation",
              installationId: row.installationId!,
            }),
          ),
        ),
      ),
    getPwaForCleanup,
    getPwa: (input) =>
      anonymousAllowed ? getPwaForCleanup(input) : Effect.fail(new AnonymousPwaUnavailable()),
    register: (input) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const id = yield* crypto.randomUUIDv4;
        const values = {
          id,
          userId: input.userId,
          environmentId: null,
          installationId: null,
          installationSecretHash: null,
          endpoint: input.payload.endpoint,
          p256dh: input.payload.keys.p256dh,
          auth: input.payload.keys.auth,
          preferencesJson: input.payload.preferences,
          createdAt: now,
          updatedAt: now,
        };
        return yield* db.$client.withTransaction(
          Effect.gen(function* () {
            // Share endpoint serialization with anonymous transfers, which can
            // delete and replace the row while this registration is waiting.
            yield* db.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${`web-push:endpoint:${values.endpoint}`}, 0))`,
            );
            // Establish a row even for concurrent first registration. Conflict
            // insertion waits for the actual winner; the locked read then sees
            // that owner, rather than an ownership snapshot from before the race.
            yield* db
              .insert(relayWebPushSubscriptions)
              .values(values)
              .onConflictDoNothing({ target: relayWebPushSubscriptions.endpoint });
            const existingRows = yield* db
              .select()
              .from(relayWebPushSubscriptions)
              .where(eq(relayWebPushSubscriptions.endpoint, input.payload.endpoint))
              .for("update");
            const existing = existingRows[0];
            if (!existing)
              return yield* new WebPushSubscriptionPersistenceError({
                cause: "subscription_missing_during_registration",
              });
            const resetBaseline =
              existing.userId !== input.userId || hasAnonymousOwnership(existing);
            const rows = yield* db
              .insert(relayWebPushSubscriptions)
              .values(values)
              .onConflictDoUpdate({
                target: relayWebPushSubscriptions.endpoint,
                set: {
                  incarnationId: sql`CASE WHEN
                    ${relayWebPushSubscriptions.userId} IS DISTINCT FROM ${input.userId}
                    OR ${relayWebPushSubscriptions.environmentId} IS NOT NULL
                    OR ${relayWebPushSubscriptions.installationId} IS NOT NULL
                    OR ${relayWebPushSubscriptions.installationSecretHash} IS NOT NULL
                    OR ${relayWebPushSubscriptions.p256dh} IS DISTINCT FROM ${input.payload.keys.p256dh}
                    OR ${relayWebPushSubscriptions.auth} IS DISTINCT FROM ${input.payload.keys.auth}
                    THEN gen_random_uuid() ELSE ${relayWebPushSubscriptions.incarnationId} END`,
                  userId: input.userId,
                  environmentId: null,
                  installationId: null,
                  installationSecretHash: null,
                  p256dh: input.payload.keys.p256dh,
                  auth: input.payload.keys.auth,
                  preferencesJson: input.payload.preferences,
                  updatedAt: now,
                },
              })
              .returning({ id: relayWebPushSubscriptions.id });
            const row = rows[0];
            if (!row)
              return yield* new WebPushSubscriptionPersistenceError({
                cause: "subscription_missing_after_registration",
              });
            if (resetBaseline) {
              yield* db
                .delete(relayWebPushSubscriptionStates)
                .where(eq(relayWebPushSubscriptionStates.subscriptionId, row.id));
            }
            return { subscriptionId: row.id };
          }),
        );
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.register")),
    remove: (input) =>
      Effect.gen(function* () {
        const deleted = yield* db
          .delete(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.userId, input.userId),
            ),
          )
          .returning({ id: relayWebPushSubscriptions.id });
        if (deleted.length === 0) return false;
        yield* db
          .delete(relayWebPushSubscriptionStates)
          .where(eq(relayWebPushSubscriptionStates.subscriptionId, input.subscriptionId));
        return true;
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.remove")),
    removeIfCurrent: Effect.fn("relay.web_push_subscriptions.remove_if_current")(function* (input) {
      return yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            const deleted = yield* db
              .delete(relayWebPushSubscriptions)
              .where(
                and(
                  eq(relayWebPushSubscriptions.userId, input.userId),
                  eq(relayWebPushSubscriptions.id, input.subscriptionId),
                  eq(relayWebPushSubscriptions.incarnationId, input.subscriptionIncarnationId),
                ),
              )
              .returning({ id: relayWebPushSubscriptions.id });
            if (deleted.length === 0) return false;
            yield* db
              .delete(relayWebPushSubscriptionStates)
              .where(eq(relayWebPushSubscriptionStates.subscriptionId, input.subscriptionId));
            return true;
          }),
        )
        .pipe(mapPersistenceError);
    }),
    get: (input) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(
            and(
              eq(relayWebPushSubscriptions.id, input.subscriptionId),
              eq(relayWebPushSubscriptions.userId, input.userId),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row && !blocksWebPushDelivery(row, anonymousAllowed) ? row : null;
      }).pipe(mapPersistenceError, Effect.withSpan("relay.web_push_subscriptions.get")),
    transition: (input) =>
      Effect.gen(function* () {
        const state = input.state;
        if (state === null) return [];
        const subscriptions = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.userId, input.userId))
          .for("update");
        const items = yield* Effect.forEach(subscriptions, (subscription) =>
          Effect.gen(function* () {
            if (blocksWebPushDelivery(subscription, anonymousAllowed)) return null;
            const previousRows = yield* db
              .select()
              .from(relayWebPushSubscriptionStates)
              .where(
                and(
                  eq(relayWebPushSubscriptionStates.subscriptionId, subscription.id),
                  eq(relayWebPushSubscriptionStates.environmentId, state.environmentId),
                  eq(relayWebPushSubscriptionStates.threadId, state.threadId),
                ),
              )
              .limit(1);
            const previous = previousRows[0];
            if (previous && previous.updatedAt >= state.updatedAt) return null;
            const baselineRows = yield* db
              .insert(relayWebPushSubscriptionStates)
              .values({
                subscriptionId: subscription.id,
                environmentId: state.environmentId,
                threadId: state.threadId,
                phase: state.phase,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                updatedAt: state.updatedAt,
              })
              .onConflictDoUpdate({
                target: [
                  relayWebPushSubscriptionStates.subscriptionId,
                  relayWebPushSubscriptionStates.environmentId,
                  relayWebPushSubscriptionStates.threadId,
                ],
                set: {
                  phase: state.phase,
                  hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                  updatedAt: state.updatedAt,
                },
                setWhere: lt(relayWebPushSubscriptionStates.updatedAt, state.updatedAt),
              })
              .returning({ updatedAt: relayWebPushSubscriptionStates.updatedAt });
            // A concurrent newer delivery won the compare-and-swap. Do not use
            // the stale pre-read baseline to produce a duplicate notification.
            if (previous && baselineRows.length === 0) return null;
            if (!previous) return null;
            const kind = notificationKind(previous, {
              ...state,
              hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
            });
            if (!kind || !wantsNotification(subscription.preferencesJson, kind)) return null;
            const copy = notificationCopy({
              state: {
                ...state,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
              },
              kind,
              names: subscription.preferencesJson.showProjectAndThreadNames,
            });
            return {
              notificationKind: kind,
              source: {
                environmentId: state.environmentId,
                threadId: state.threadId,
                notificationKind: kind,
                stateVersion: stateVersion(state),
              },
              eventId: `web:${subscription.id}:${state.environmentId}:${state.threadId}:${kind}:${state.updatedAt}`,
              deepLink: state.deepLink,
              showProjectAndThreadNames: subscription.preferencesJson.showProjectAndThreadNames,
              title: copy.title,
              body: copy.body,
              subscription,
            } satisfies WebPushNotification;
          }),
        );
        return items.filter((item) => item !== null);
      }).pipe(
        db.$client.withTransaction,
        mapPersistenceError,
        Effect.withSpan("relay.web_push_subscriptions.transition"),
      ),
    transitionEnvironment: (input) =>
      Effect.gen(function* () {
        if (!anonymousAllowed) return [];
        const state = input.state;
        if (state === null) return [];
        const subscriptions = yield* db
          .select()
          .from(relayWebPushSubscriptions)
          .where(eq(relayWebPushSubscriptions.environmentId, input.environmentId))
          .for("update");
        const items = yield* Effect.forEach(subscriptions, (subscription) =>
          Effect.gen(function* () {
            if (blocksWebPushDelivery(subscription, anonymousAllowed)) return null;
            const previousRows = yield* db
              .select()
              .from(relayWebPushSubscriptionStates)
              .where(
                and(
                  eq(relayWebPushSubscriptionStates.subscriptionId, subscription.id),
                  eq(relayWebPushSubscriptionStates.environmentId, state.environmentId),
                  eq(relayWebPushSubscriptionStates.threadId, state.threadId),
                ),
              )
              .limit(1);
            const previous = previousRows[0];
            if (previous && previous.updatedAt >= state.updatedAt) return null;
            const baselineRows = yield* db
              .insert(relayWebPushSubscriptionStates)
              .values({
                subscriptionId: subscription.id,
                environmentId: state.environmentId,
                threadId: state.threadId,
                phase: state.phase,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                updatedAt: state.updatedAt,
              })
              .onConflictDoUpdate({
                target: [
                  relayWebPushSubscriptionStates.subscriptionId,
                  relayWebPushSubscriptionStates.environmentId,
                  relayWebPushSubscriptionStates.threadId,
                ],
                set: {
                  phase: state.phase,
                  hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
                  updatedAt: state.updatedAt,
                },
                setWhere: lt(relayWebPushSubscriptionStates.updatedAt, state.updatedAt),
              })
              .returning({ updatedAt: relayWebPushSubscriptionStates.updatedAt });
            if ((previous && baselineRows.length === 0) || !previous) return null;
            const kind = notificationKind(previous, {
              ...state,
              hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
            });
            if (!kind || !wantsNotification(subscription.preferencesJson, kind)) return null;
            const copy = notificationCopy({
              state: {
                ...state,
                hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
              },
              kind,
              names: subscription.preferencesJson.showProjectAndThreadNames,
            });
            return {
              notificationKind: kind,
              source: {
                environmentId: state.environmentId,
                threadId: state.threadId,
                notificationKind: kind,
                stateVersion: stateVersion(state),
              },
              eventId: `web:${subscription.id}:${state.environmentId}:${state.threadId}:${kind}:${state.updatedAt}`,
              deepLink: state.deepLink,
              showProjectAndThreadNames: subscription.preferencesJson.showProjectAndThreadNames,
              title: copy.title,
              body: copy.body,
              subscription,
            } satisfies WebPushNotification;
          }),
        );
        return items.filter((item) => item !== null);
      }).pipe(
        (effect) => (anonymousAllowed ? db.$client.withTransaction(effect) : effect),
        mapPersistenceError,
        Effect.withSpan("relay.web_push_subscriptions.transition_environment"),
      ),
  });
});

export const layer = Layer.effect(WebPushSubscriptions, make);
