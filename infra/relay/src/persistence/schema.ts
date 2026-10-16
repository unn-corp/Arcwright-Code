import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
  RelayWebPushPreferences,
  RelayManagedEndpointOrigin,
} from "@t3tools/contracts/relay";
import {
  boolean,
  check,
  index,
  integer,
  doublePrecision,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  LifecycleState,
  OperationKind,
  PendingMutation,
  ResourcePresence,
} from "../environments/managedEndpointLifecycleContracts.ts";
import { pendingMutationCheck } from "../environments/managedEndpointLifecycleConstraints.ts";

export const relayMobileDevices = pgTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios" | "android">(),
    iosMajorVersion: integer("ios_major_version"),
    androidApiLevel: integer("android_api_level"),
    appVersion: varchar("app_version", { length: 64 }),
    bundleId: varchar("bundle_id", { length: 255 }),
    apsEnvironment: varchar("aps_environment", { length: 16 }).$type<"sandbox" | "production">(),
    pushToken: text("push_token"),
    pushToStartToken: text("push_to_start_token"),
    preferencesJson: jsonb("preferences_json").notNull().$type<RelayAgentAwarenessPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = pgTable(
  "relay_live_activities",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    activityPushToken: text("activity_push_token"),
    remoteStartQueuedAt: varchar("remote_start_queued_at", { length: 64 }),
    remoteStartedAt: varchar("remote_started_at", { length: 64 }),
    endedAt: varchar("ended_at", { length: 64 }),
    lastAggregateJson: jsonb("last_aggregate_json").$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: varchar("last_live_activity_delivery_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

/** One standards-based Push API subscription for a browser or installed PWA. */
export const relayWebPushSubscriptions = pgTable(
  "relay_web_push_subscriptions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    incarnationId: uuid("incarnation_id").notNull().defaultRandom(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    // Anonymous PWA ownership is deliberately separate from an Arcwright Connect
    // account. Only a one-way hash of the opaque bearer credential is stored.
    environmentId: varchar("environment_id", { length: 191 }),
    installationId: varchar("installation_id", { length: 128 }),
    installationSecretHash: text("installation_secret_hash"),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    preferencesJson: jsonb("preferences_json").notNull().$type<RelayWebPushPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_web_push_subscriptions_endpoint").on(table.endpoint),
    index("idx_relay_web_push_subscriptions_user").on(table.userId),
    index("idx_relay_web_push_subscriptions_environment").on(table.environmentId),
    uniqueIndex("idx_relay_web_push_subscriptions_installation").on(table.installationId),
  ],
);

/** Durable per-subscription transition baseline prevents replaying old work as new alerts. */
export const relayWebPushSubscriptionStates = pgTable(
  "relay_web_push_subscription_states",
  {
    subscriptionId: varchar("subscription_id", { length: 64 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    threadId: varchar("thread_id", { length: 191 }).notNull(),
    phase: varchar("phase", { length: 64 }).notNull(),
    hasActionableProposedPlan: boolean("has_actionable_proposed_plan").notNull().default(false),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      // PostgreSQL truncated this name in the original handwritten migration.
      name: "relay_web_push_subscription_states_subscription_id_environment_",
      columns: [table.subscriptionId, table.environmentId, table.threadId],
    }),
    index("idx_relay_web_push_subscription_states_subscription").on(table.subscriptionId),
  ],
);

export const relayEnvironmentLinks = pgTable(
  "relay_environment_links",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    incarnationId: uuid("incarnation_id").notNull().defaultRandom(),
    environmentLabel: text("environment_label").notNull().default("Arcwright Code Environment"),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: varchar("endpoint_provider_kind", { length: 32 }).notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    liveActivitiesEnabled: boolean("live_activities_enabled").notNull().default(true),
    managedTunnelsEnabled: boolean("managed_tunnels_enabled").notNull().default(false),
    holdWebhooksWhileOffline: boolean("hold_webhooks_while_offline").notNull().default(false),
    createdByDeviceId: varchar("created_by_device_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    linkedAt: varchar("linked_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = pgTable(
  "relay_managed_endpoint_allocations",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    tunnelName: text("tunnel_name").notNull(),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    readyAt: varchar("ready_at", { length: 64 }),
    recoveryEnabledAt: varchar("recovery_enabled_at", { length: 64 }),
    recoveryEnvironmentPublicKey: text("recovery_environment_public_key"),
    tunnelReleasedAt: varchar("tunnel_released_at", { length: 64 }),
    origin: jsonb("origin").$type<RelayManagedEndpointOrigin>(),
    generation: integer("generation").notNull().default(0),
    allocationId: uuid("allocation_id").notNull().defaultRandom(),
    // Unfenced writers have no verifiable protocol history. Fresh idle admission
    // requires the coordinated provider/publication conversion.
    lifecycleState: varchar("lifecycle_state", { length: 24 })
      .notNull()
      .default("legacy_unverified")
      .$type<LifecycleState>(),
    operationId: uuid("operation_id"),
    operationKind: varchar("operation_kind", { length: 16 }).$type<OperationKind>(),
    operationStartedAt: varchar("operation_started_at", { length: 64 }),
    pendingMutation: jsonb("pending_mutation").$type<PendingMutation>(),
    cleanupRequested: boolean("cleanup_requested").notNull().default(false),
    tunnelPresence: varchar("tunnel_presence", { length: 16 })
      .notNull()
      .default("unresolved")
      .$type<ResourcePresence>(),
    dnsPresence: varchar("dns_presence", { length: 16 })
      .notNull()
      .default("unresolved")
      .$type<ResourcePresence>(),
    dnsTargetTunnelId: varchar("dns_target_tunnel_id", { length: 191 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
    uniqueIndex("idx_relay_managed_endpoint_allocations_id").on(table.allocationId),
    check(
      "chk_managed_endpoint_lifecycle_values",
      sql`"lifecycle_state" IN ('idle', 'owned', 'uncertain', 'legacy_unverified') AND ("operation_kind" IS NULL OR "operation_kind" IN ('provision', 'release', 'deprovision', 'reconcile')) AND "tunnel_presence" IN ('unresolved', 'never_created', 'recorded', 'absent') AND "dns_presence" IN ('unresolved', 'never_created', 'recorded', 'absent') AND "generation" >= 0`,
    ),
    check(
      "chk_managed_endpoint_owner",
      sql`("lifecycle_state" IN ('idle', 'legacy_unverified') AND "operation_id" IS NULL AND "operation_kind" IS NULL AND "operation_started_at" IS NULL AND "pending_mutation" IS NULL) OR ("lifecycle_state" IN ('owned', 'uncertain') AND "operation_id" IS NOT NULL AND "operation_kind" IS NOT NULL AND "operation_started_at" IS NOT NULL)`,
    ),
    check(
      "chk_managed_endpoint_recorded_presence",
      sql`("tunnel_presence" <> 'recorded' OR "tunnel_id" IS NOT NULL) AND ("dns_presence" <> 'recorded' OR ("dns_record_id" IS NOT NULL AND "dns_target_tunnel_id" IS NOT NULL))`,
    ),
    check("chk_managed_endpoint_pending", sql.raw(pendingMutationCheck)),
  ],
);

export const relayManagedTunnelLimits = pgTable("relay_managed_tunnel_limits", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  maxTunnels: integer("max_tunnels").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayEnvironmentCredentials = pgTable(
  "relay_environment_credentials",
  {
    credentialId: varchar("credential_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialHash: varchar("credential_hash", { length: 191 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayAgentActivityRows = pgTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: varchar("thread_id", { length: 512 }).notNull(),
    stateJson: jsonb("state_json").notNull().$type<RelayAgentActivityState>(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = pgTable(
  "relay_delivery_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 512 }),
    deviceId: varchar("device_id", { length: 255 }),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceJobId: varchar("source_job_id", { length: 64 }),
    tokenSuffix: varchar("token_suffix", { length: 16 }),
    apnsStatus: integer("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: varchar("apns_id", { length: 128 }),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_environment").on(
      table.environmentId,
      table.threadId,
      table.createdAt,
    ),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = pgTable(
  "relay_dpop_proofs",
  {
    thumbprint: varchar("thumbprint", { length: 128 }).notNull(),
    jti: varchar("jti", { length: 255 }).notNull(),
    iat: integer("iat").notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);

// These isolated D1 tables are not runtime-bound. No old subject-only row is
// attributed by migration. Identity/progress immutability is also enforced by
// table-specific migration triggers (Drizzle snapshots represent checks/FKs).
const accountIdentityCheck = sql.raw(
  String.raw`length("issuer") BETWEEN 1 AND 2048 AND "issuer" ~ '^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(:[1-9][0-9]{0,4})?$' AND (substring("issuer" from ':([0-9]+)$') IS NULL OR (substring("issuer" from ':([0-9]+)$')::integer BETWEEN 1 AND 65535 AND (substring("issuer" from ':([0-9]+)$')::integer <> 443))) AND length("instance_id") BETWEEN 1 AND 191 AND "instance_id" ~ '^[A-Za-z0-9._:-]+$' AND length("user_id") BETWEEN 6 AND 191 AND "user_id" ~ '^user_[A-Za-z0-9]+$'`,
);
export const relayAccountAuthorities = pgTable(
  "relay_account_authorities",
  {
    userId: varchar("user_id", { length: 191 }).primaryKey(),
    issuer: varchar("issuer", { length: 2048 }).notNull(),
    instanceId: varchar("instance_id", { length: 191 }).notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_account_authority_identity").on(table.issuer, table.instanceId, table.userId),
    check("chk_account_authority_identity", accountIdentityCheck),
    check("chk_account_authority_time", sql`isfinite("bound_at")`),
  ],
);
export const relayAccountDeletions = pgTable(
  "relay_account_deletions",
  {
    issuer: varchar("issuer", { length: 2048 }).notNull(),
    instanceId: varchar("instance_id", { length: 191 }).notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    intentId: uuid("intent_id").notNull().defaultRandom().unique("uq_account_deletion_intent"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    sourceManual: boolean("source_manual").notNull().default(false),
    sourceWebhook: boolean("source_webhook").notNull().default(false),
    identityDeletedAt: timestamp("identity_deleted_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    localPurgedAt: timestamp("local_purged_at", { withTimezone: true, mode: "string" }),
    status: varchar("status", { length: 16 })
      .notNull()
      .default("pending")
      .$type<"pending" | "blocked_repair" | "complete">(),
    reason: varchar("reason", { length: 32 }).$type<"authority_unverified">(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    primaryKey({
      name: "pk_account_deletion_identity",
      columns: [table.issuer, table.instanceId, table.userId],
    }),
    check("chk_account_deletion_identity", accountIdentityCheck),
    check(
      "chk_account_deletion_state",
      sql`"status" IN ('pending', 'blocked_repair', 'complete') AND ("reason" IS NULL OR "reason" IN ('authority_unverified')) AND "attempt_count" >= 0`,
    ),
    check(
      "chk_account_deletion_complete",
      sql`("status" <> 'complete' OR ("identity_deleted_at" IS NOT NULL AND "revoked_at" IS NOT NULL AND "local_purged_at" IS NOT NULL AND "completed_at" IS NOT NULL)) AND ("completed_at" IS NULL OR "status" = 'complete')`,
    ),
    check(
      "chk_account_deletion_times",
      sql`isfinite("requested_at") AND isfinite("next_attempt_at") AND ("identity_deleted_at" IS NULL OR isfinite("identity_deleted_at")) AND ("revoked_at" IS NULL OR isfinite("revoked_at")) AND ("local_purged_at" IS NULL OR isfinite("local_purged_at")) AND ("completed_at" IS NULL OR isfinite("completed_at"))`,
    ),
  ],
);
export const relayAccountDeletionEvents = pgTable(
  "relay_account_deletion_events",
  {
    instanceId: varchar("instance_id", { length: 191 }).notNull(),
    svixId: varchar("svix_id", { length: 255 }).notNull(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => relayAccountDeletions.intentId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    eventTimestamp: doublePrecision("event_timestamp").notNull(),
  },
  (table) => [
    primaryKey({ name: "pk_account_deletion_event", columns: [table.instanceId, table.svixId] }),
    check(
      "chk_account_deletion_event_identity",
      sql`length("instance_id") BETWEEN 1 AND 191 AND "instance_id" ~ '^[A-Za-z0-9._:-]+$' AND length("svix_id") BETWEEN 1 AND 255 AND "svix_id" ~ '^[A-Za-z0-9._:-]+$'`,
    ),
    check(
      "chk_account_deletion_event_time",
      sql`isfinite("received_at") AND "event_timestamp" > '-Infinity'::double precision AND "event_timestamp" < 'Infinity'::double precision`,
    ),
  ],
);
export const relayAccountDeletionEndpoints = pgTable(
  "relay_account_deletion_endpoints",
  {
    intentId: uuid("intent_id")
      .notNull()
      .references(() => relayAccountDeletions.intentId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    allocationId: uuid("allocation_id").notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    observedGeneration: integer("observed_generation").notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    tunnelName: varchar("tunnel_name", { length: 253 }).notNull(),
    endpointKey: varchar("endpoint_key", { length: 253 }).notNull(),
    namespace: varchar("namespace", { length: 191 }).notNull(),
    hooksDisabledAt: timestamp("hooks_disabled_at", { withTimezone: true, mode: "string" }),
    allocationRemovedAt: timestamp("allocation_removed_at", { withTimezone: true, mode: "string" }),
    reason: varchar("reason", { length: 32 }).$type<
      "endpoint_unverified" | "endpoint_busy" | "endpoint_uncertain"
    >(),
  },
  (table) => [
    primaryKey({
      name: "pk_account_deletion_endpoint",
      columns: [table.intentId, table.allocationId],
    }),
    check(
      "chk_account_deletion_endpoint_identity",
      sql`"observed_generation" >= 0 AND length("environment_id") BETWEEN 1 AND 191 AND "environment_id" ~ '^[A-Za-z0-9._:-]+$' AND length("tunnel_name") BETWEEN 1 AND 253 AND "tunnel_name" ~ '^[A-Za-z0-9._:-]+$' AND length("endpoint_key") BETWEEN 1 AND 253 AND "endpoint_key" ~ '^[A-Za-z0-9._:-]+$' AND length("namespace") BETWEEN 1 AND 191 AND "namespace" ~ '^[A-Za-z0-9._:-]+$' AND ("tunnel_id" IS NULL OR (length("tunnel_id") BETWEEN 1 AND 191 AND "tunnel_id" ~ '^[A-Za-z0-9._:-]+$')) AND ("dns_record_id" IS NULL OR (length("dns_record_id") BETWEEN 1 AND 191 AND "dns_record_id" ~ '^[A-Za-z0-9._:-]+$'))`,
    ),
    check(
      "chk_account_deletion_endpoint_progress",
      sql`("reason" IS NULL OR "reason" IN ('endpoint_unverified', 'endpoint_busy', 'endpoint_uncertain')) AND ("hooks_disabled_at" IS NULL OR isfinite("hooks_disabled_at")) AND ("allocation_removed_at" IS NULL OR isfinite("allocation_removed_at"))`,
    ),
  ],
);
