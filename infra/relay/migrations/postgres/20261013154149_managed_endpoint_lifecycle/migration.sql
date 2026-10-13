ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "allocation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "lifecycle_state" varchar(24) DEFAULT 'legacy_unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "operation_kind" varchar(16);--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "operation_started_at" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "pending_mutation" jsonb;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "cleanup_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "tunnel_presence" varchar(16) DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "dns_presence" varchar(16) DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD COLUMN "dns_target_tunnel_id" varchar(191);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_managed_endpoint_allocations_id" ON "relay_managed_endpoint_allocations" ("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD CONSTRAINT "chk_managed_endpoint_lifecycle_values" CHECK ("lifecycle_state" IN ('idle', 'owned', 'uncertain', 'legacy_unverified') AND ("operation_kind" IS NULL OR "operation_kind" IN ('provision', 'release', 'deprovision', 'reconcile')) AND "tunnel_presence" IN ('unresolved', 'never_created', 'recorded', 'absent') AND "dns_presence" IN ('unresolved', 'never_created', 'recorded', 'absent') AND "generation" >= 0);--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD CONSTRAINT "chk_managed_endpoint_owner" CHECK (("lifecycle_state" IN ('idle', 'legacy_unverified') AND "operation_id" IS NULL AND "operation_kind" IS NULL AND "operation_started_at" IS NULL AND "pending_mutation" IS NULL) OR ("lifecycle_state" IN ('owned', 'uncertain') AND "operation_id" IS NOT NULL AND "operation_kind" IS NOT NULL AND "operation_started_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD CONSTRAINT "chk_managed_endpoint_recorded_presence" CHECK (("tunnel_presence" <> 'recorded' OR "tunnel_id" IS NOT NULL) AND ("dns_presence" <> 'recorded' OR ("dns_record_id" IS NOT NULL AND "dns_target_tunnel_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "relay_managed_endpoint_allocations" ADD CONSTRAINT "chk_managed_endpoint_pending" CHECK ("pending_mutation" IS NULL OR COALESCE((
  jsonb_typeof("pending_mutation") = 'object'
  AND octet_length("pending_mutation"::text) <= 2048
  AND ("pending_mutation"->>'stepId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND (
    ("pending_mutation"->>'action' = 'create_tunnel' AND "pending_mutation" - ARRAY['action', 'stepId', 'tunnelName']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'tunnelName') = 'string' AND length("pending_mutation"->>'tunnelName') BETWEEN 1 AND 253))
    OR ("pending_mutation"->>'action' = 'configure_tunnel' AND "pending_mutation" - ARRAY['action', 'stepId', 'tunnelId', 'tunnelName', 'origin']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'tunnelId') = 'string' AND length("pending_mutation"->>'tunnelId') BETWEEN 1 AND 191) AND (jsonb_typeof("pending_mutation"->'tunnelName') = 'string' AND length("pending_mutation"->>'tunnelName') BETWEEN 1 AND 253) AND (
  jsonb_typeof("pending_mutation"->'origin') = 'object'
  AND ("pending_mutation"->'origin') - ARRAY['localHttpHost', 'localHttpPort']::text[] = '{}'::jsonb
  AND "pending_mutation"->'origin'->>'localHttpHost' IN ('localhost', '127.0.0.1', '::1', '[::1]')
  AND jsonb_typeof("pending_mutation"->'origin'->'localHttpPort') = 'number'
  AND ("pending_mutation"->'origin'->>'localHttpPort') ~ '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$'
))
    OR ("pending_mutation"->>'action' = 'delete_tunnel' AND "pending_mutation" - ARRAY['action', 'stepId', 'tunnelId', 'tunnelName']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'tunnelId') = 'string' AND length("pending_mutation"->>'tunnelId') BETWEEN 1 AND 191) AND (jsonb_typeof("pending_mutation"->'tunnelName') = 'string' AND length("pending_mutation"->>'tunnelName') BETWEEN 1 AND 253))
    OR ("pending_mutation"->>'action' = 'create_dns' AND "pending_mutation" - ARRAY['action', 'stepId', 'hostname', 'tunnelId']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'hostname') = 'string' AND length("pending_mutation"->>'hostname') BETWEEN 1 AND 253) AND (jsonb_typeof("pending_mutation"->'tunnelId') = 'string' AND length("pending_mutation"->>'tunnelId') BETWEEN 1 AND 191))
    OR ("pending_mutation"->>'action' = 'update_dns' AND "pending_mutation" - ARRAY['action', 'stepId', 'dnsRecordId', 'hostname', 'previousTunnelId', 'nextTunnelId']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'dnsRecordId') = 'string' AND length("pending_mutation"->>'dnsRecordId') BETWEEN 1 AND 191) AND (jsonb_typeof("pending_mutation"->'hostname') = 'string' AND length("pending_mutation"->>'hostname') BETWEEN 1 AND 253) AND (jsonb_typeof("pending_mutation"->'previousTunnelId') = 'string' AND length("pending_mutation"->>'previousTunnelId') BETWEEN 1 AND 191) AND (jsonb_typeof("pending_mutation"->'nextTunnelId') = 'string' AND length("pending_mutation"->>'nextTunnelId') BETWEEN 1 AND 191))
    OR ("pending_mutation"->>'action' = 'delete_dns' AND "pending_mutation" - ARRAY['action', 'stepId', 'dnsRecordId', 'hostname', 'previousTunnelId']::text[] = '{}'::jsonb AND (jsonb_typeof("pending_mutation"->'dnsRecordId') = 'string' AND length("pending_mutation"->>'dnsRecordId') BETWEEN 1 AND 191) AND (jsonb_typeof("pending_mutation"->'hostname') = 'string' AND length("pending_mutation"->>'hostname') BETWEEN 1 AND 253) AND (jsonb_typeof("pending_mutation"->'previousTunnelId') = 'string' AND length("pending_mutation"->>'previousTunnelId') BETWEEN 1 AND 191))
  )
), false));