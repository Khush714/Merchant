-- Signed courier/payment webhook state, matching drizzle/0011_provider_events.sql.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "courier_status" text DEFAULT '' NOT NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "courier_tracking_id" text DEFAULT '' NOT NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "courier_updated_at" timestamp with time zone;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "payment_reference" text DEFAULT '' NOT NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS "payment_updated_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.provider_events (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES public.businesses("id") ON DELETE CASCADE,
  "order_id" uuid REFERENCES public.orders("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "outcome" text DEFAULT 'applied' NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "payload_hash" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_events_provider_event_idx"
  ON public.provider_events USING btree ("provider", "event_id");
CREATE INDEX IF NOT EXISTS "provider_events_business_idx"
  ON public.provider_events USING btree ("business_id", "created_at");
CREATE INDEX IF NOT EXISTS "provider_events_order_idx"
  ON public.provider_events USING btree ("order_id");
