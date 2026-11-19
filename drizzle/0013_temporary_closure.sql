ALTER TABLE "businesses" ADD COLUMN "closure_reason" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "closure_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "scheduled_leaves" jsonb DEFAULT '[]'::jsonb NOT NULL;