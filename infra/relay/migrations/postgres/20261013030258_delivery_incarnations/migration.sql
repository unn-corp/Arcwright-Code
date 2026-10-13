-- Historical activation provenance must be a real ISO timestamp. Preserve its
-- exact bytes; never invent a replacement for an invalid historical date.
DO $$
DECLARE historical_created_at text;
BEGIN
  FOR historical_created_at IN SELECT created_at FROM relay_environment_links LOOP
    IF historical_created_at !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
      RAISE EXCEPTION 'Environment link created_at is not an ISO timestamp';
    END IF;
    PERFORM historical_created_at::timestamptz;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "incarnation_id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "relay_environment_links" ADD COLUMN "linked_at" varchar(64);
--> statement-breakpoint
UPDATE "relay_environment_links" SET "linked_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "relay_environment_links" ALTER COLUMN "linked_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "relay_web_push_subscriptions" ADD COLUMN "incarnation_id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
-- Align the existing branded schema default without rewriting historical labels.
ALTER TABLE "relay_environment_links" ALTER COLUMN "environment_label" SET DEFAULT 'Arcwright Code Environment';
