-- Additive settlement-line version markers and immutable statement snapshots.
-- Existing financial amounts and identifiers are untouched; legacy rows are backfilled
-- so incremental processing can detect and safely upgrade them.
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "line_version" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "fee_schedule_id" uuid REFERENCES "fee_schedules"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "rebuilt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "expected_net_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD COLUMN IF NOT EXISTS "matches_authoritative" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD COLUMN IF NOT EXISTS "line_snapshot" jsonb;--> statement-breakpoint
UPDATE "settlement_lines" AS l SET "expected_net_paise" = l."gross_paise" - l."commission_paise" - l."refund_paise" + l."adjustment_paise";--> statement-breakpoint
UPDATE "settlement_lines" AS l SET "matches_authoritative" = (l."net_paise" = l."expected_net_paise");--> statement-breakpoint
UPDATE "settlement_lines" AS l SET "source_updated_at" = s."source_updated_at" FROM "settlements" AS s WHERE l."settlement_id" = s."id" AND l."source_updated_at" IS NULL;
