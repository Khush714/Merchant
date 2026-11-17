CREATE TABLE IF NOT EXISTS "delivery_mirror_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id"),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id"),
  "status" text DEFAULT 'pending' NOT NULL,
  "owner" text DEFAULT 'merchant' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_mirror_jobs_order_idx" ON "delivery_mirror_jobs" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_mirror_jobs_business_idx" ON "delivery_mirror_jobs" USING btree ("business_id");
