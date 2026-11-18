ALTER TABLE "orders" ADD COLUMN "rating" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "review" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "feedback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_response" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_responded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_business_feedback_idx" ON "orders" USING btree ("business_id","feedback_at");
