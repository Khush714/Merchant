ALTER TABLE "businesses" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "delivery_radius_meters" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "delivery_zones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "weekly_hours" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "day_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;