CREATE TABLE "relay_account_authorities" (
	"user_id" varchar(191) PRIMARY KEY,
	"issuer" varchar(2048) NOT NULL,
	"instance_id" varchar(191) NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_account_authority_identity" CHECK (length("issuer") BETWEEN 1 AND 2048 AND "issuer" ~ '^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(:[1-9][0-9]{0,4})?$' AND (substring("issuer" from ':([0-9]+)$') IS NULL OR (substring("issuer" from ':([0-9]+)$')::integer BETWEEN 1 AND 65535 AND (substring("issuer" from ':([0-9]+)$')::integer <> 443))) AND length("instance_id") BETWEEN 1 AND 191 AND "instance_id" ~ '^[A-Za-z0-9._:-]+$' AND length("user_id") BETWEEN 6 AND 191 AND "user_id" ~ '^user_[A-Za-z0-9]+$'),
	CONSTRAINT "chk_account_authority_time" CHECK (isfinite("bound_at"))
);
--> statement-breakpoint
CREATE TABLE "relay_account_deletion_endpoints" (
	"intent_id" uuid,
	"allocation_id" uuid,
	"environment_id" varchar(191) NOT NULL,
	"observed_generation" integer NOT NULL,
	"tunnel_id" varchar(191),
	"dns_record_id" varchar(191),
	"tunnel_name" varchar(253) NOT NULL,
	"endpoint_key" varchar(253) NOT NULL,
	"namespace" varchar(191) NOT NULL,
	"hooks_disabled_at" timestamp with time zone,
	"allocation_removed_at" timestamp with time zone,
	"reason" varchar(32),
	CONSTRAINT "pk_account_deletion_endpoint" PRIMARY KEY("intent_id","allocation_id"),
	CONSTRAINT "chk_account_deletion_endpoint_identity" CHECK ("observed_generation" >= 0 AND length("environment_id") BETWEEN 1 AND 191 AND "environment_id" ~ '^[A-Za-z0-9._:-]+$' AND length("tunnel_name") BETWEEN 1 AND 253 AND "tunnel_name" ~ '^[A-Za-z0-9._:-]+$' AND length("endpoint_key") BETWEEN 1 AND 253 AND "endpoint_key" ~ '^[A-Za-z0-9._:-]+$' AND length("namespace") BETWEEN 1 AND 191 AND "namespace" ~ '^[A-Za-z0-9._:-]+$' AND ("tunnel_id" IS NULL OR (length("tunnel_id") BETWEEN 1 AND 191 AND "tunnel_id" ~ '^[A-Za-z0-9._:-]+$')) AND ("dns_record_id" IS NULL OR (length("dns_record_id") BETWEEN 1 AND 191 AND "dns_record_id" ~ '^[A-Za-z0-9._:-]+$'))),
	CONSTRAINT "chk_account_deletion_endpoint_progress" CHECK (("reason" IS NULL OR "reason" IN ('endpoint_unverified', 'endpoint_busy', 'endpoint_uncertain')) AND ("hooks_disabled_at" IS NULL OR isfinite("hooks_disabled_at")) AND ("allocation_removed_at" IS NULL OR isfinite("allocation_removed_at")))
);
--> statement-breakpoint
CREATE TABLE "relay_account_deletion_events" (
	"instance_id" varchar(191),
	"svix_id" varchar(255),
	"intent_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_timestamp" double precision NOT NULL,
	CONSTRAINT "pk_account_deletion_event" PRIMARY KEY("instance_id","svix_id"),
	CONSTRAINT "chk_account_deletion_event_identity" CHECK (length("instance_id") BETWEEN 1 AND 191 AND "instance_id" ~ '^[A-Za-z0-9._:-]+$' AND length("svix_id") BETWEEN 1 AND 255 AND "svix_id" ~ '^[A-Za-z0-9._:-]+$'),
	CONSTRAINT "chk_account_deletion_event_time" CHECK (isfinite("received_at") AND "event_timestamp" > '-Infinity'::double precision AND "event_timestamp" < 'Infinity'::double precision)
);
--> statement-breakpoint
CREATE TABLE "relay_account_deletions" (
	"issuer" varchar(2048),
	"instance_id" varchar(191),
	"user_id" varchar(191),
	"intent_id" uuid DEFAULT gen_random_uuid() NOT NULL CONSTRAINT "uq_account_deletion_intent" UNIQUE,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_manual" boolean DEFAULT false NOT NULL,
	"source_webhook" boolean DEFAULT false NOT NULL,
	"identity_deleted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"local_purged_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reason" varchar(32),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pk_account_deletion_identity" PRIMARY KEY("issuer","instance_id","user_id"),
	CONSTRAINT "chk_account_deletion_identity" CHECK (length("issuer") BETWEEN 1 AND 2048 AND "issuer" ~ '^https://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(:[1-9][0-9]{0,4})?$' AND (substring("issuer" from ':([0-9]+)$') IS NULL OR (substring("issuer" from ':([0-9]+)$')::integer BETWEEN 1 AND 65535 AND (substring("issuer" from ':([0-9]+)$')::integer <> 443))) AND length("instance_id") BETWEEN 1 AND 191 AND "instance_id" ~ '^[A-Za-z0-9._:-]+$' AND length("user_id") BETWEEN 6 AND 191 AND "user_id" ~ '^user_[A-Za-z0-9]+$'),
	CONSTRAINT "chk_account_deletion_state" CHECK ("status" IN ('pending', 'blocked_repair', 'complete') AND ("reason" IS NULL OR "reason" IN ('authority_unverified')) AND "attempt_count" >= 0),
	CONSTRAINT "chk_account_deletion_complete" CHECK (("status" <> 'complete' OR ("identity_deleted_at" IS NOT NULL AND "revoked_at" IS NOT NULL AND "local_purged_at" IS NOT NULL AND "completed_at" IS NOT NULL)) AND ("completed_at" IS NULL OR "status" = 'complete')),
	CONSTRAINT "chk_account_deletion_times" CHECK (isfinite("requested_at") AND isfinite("next_attempt_at") AND ("identity_deleted_at" IS NULL OR isfinite("identity_deleted_at")) AND ("revoked_at" IS NULL OR isfinite("revoked_at")) AND ("local_purged_at" IS NULL OR isfinite("local_purged_at")) AND ("completed_at" IS NULL OR isfinite("completed_at")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_authority_identity" ON "relay_account_authorities" ("issuer","instance_id","user_id");--> statement-breakpoint
ALTER TABLE "relay_account_deletion_endpoints" ADD CONSTRAINT "relay_account_deletion_endpoints_G4lZB9KZxkbn_fkey" FOREIGN KEY ("intent_id") REFERENCES "relay_account_deletions"("intent_id") ON DELETE RESTRICT ON UPDATE RESTRICT;--> statement-breakpoint
ALTER TABLE "relay_account_deletion_events" ADD CONSTRAINT "relay_account_deletion_events_0spejM6jpsbk_fkey" FOREIGN KEY ("intent_id") REFERENCES "relay_account_deletions"("intent_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint
-- Custom table-specific guards are not represented by Drizzle snapshot DDL.
-- Keep exact provenance, permanent denies and recorded target identities;
-- mutable source/progress fields remain available to convergent intake/cleanup.
CREATE FUNCTION relay_account_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_authority_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'account_authority_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_authority_immutable BEFORE UPDATE OR DELETE ON relay_account_authorities FOR EACH ROW EXECUTE FUNCTION relay_account_authority_immutable();
--> statement-breakpoint
CREATE FUNCTION relay_account_deletion_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_deny_permanent' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.issuer, NEW.instance_id, NEW.user_id, NEW.intent_id, NEW.requested_at)
      IS DISTINCT FROM ROW(OLD.issuer, OLD.instance_id, OLD.user_id, OLD.intent_id, OLD.requested_at)
    OR (OLD.source_manual AND NOT NEW.source_manual)
    OR (OLD.source_webhook AND NOT NEW.source_webhook)
    OR (OLD.identity_deleted_at IS NOT NULL AND NEW.identity_deleted_at IS DISTINCT FROM OLD.identity_deleted_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.local_purged_at IS NOT NULL AND NEW.local_purged_at IS DISTINCT FROM OLD.local_purged_at)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.status = 'complete' AND NEW.status <> 'complete')
    OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'account_deletion_monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_monotonic BEFORE UPDATE OR DELETE ON relay_account_deletions FOR EACH ROW EXECUTE FUNCTION relay_account_deletion_monotonic();
--> statement-breakpoint
CREATE FUNCTION relay_account_deletion_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_receipt_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'account_receipt_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_event_immutable BEFORE UPDATE OR DELETE ON relay_account_deletion_events FOR EACH ROW EXECUTE FUNCTION relay_account_deletion_event_immutable();
--> statement-breakpoint
CREATE FUNCTION relay_account_deletion_endpoint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_endpoint_immutable' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.intent_id, NEW.allocation_id, NEW.environment_id, NEW.observed_generation,
        NEW.tunnel_id, NEW.dns_record_id, NEW.tunnel_name, NEW.endpoint_key, NEW.namespace)
    IS DISTINCT FROM ROW(OLD.intent_id, OLD.allocation_id, OLD.environment_id, OLD.observed_generation,
        OLD.tunnel_id, OLD.dns_record_id, OLD.tunnel_name, OLD.endpoint_key, OLD.namespace)
    OR (OLD.hooks_disabled_at IS NOT NULL AND NEW.hooks_disabled_at IS DISTINCT FROM OLD.hooks_disabled_at)
    OR (OLD.allocation_removed_at IS NOT NULL AND NEW.allocation_removed_at IS DISTINCT FROM OLD.allocation_removed_at) THEN
    RAISE EXCEPTION 'account_endpoint_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER account_deletion_endpoint_immutable BEFORE UPDATE OR DELETE ON relay_account_deletion_endpoints FOR EACH ROW EXECUTE FUNCTION relay_account_deletion_endpoint_immutable();
