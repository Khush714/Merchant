ALTER TABLE "business_marketplace_links" ADD COLUMN "settlement_sync_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "business_marketplace_links" ADD COLUMN "settlements_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "external_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "marketplace_order_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "order_number" integer;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "gross_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "commission_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "refund_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "adjustment_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "settlements" SET "external_id" = "id"::text, "marketplace_order_id" = "id"::text WHERE "external_id" = '' OR "marketplace_order_id" = '';--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_business_external_idx" ON "settlements" USING btree ("business_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_business_order_idx" ON "settlements" USING btree ("business_id","marketplace_order_id");