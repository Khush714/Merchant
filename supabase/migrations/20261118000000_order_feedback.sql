-- Customer feedback on completed first-party marketplace orders, matching drizzle/0008_order_feedback.sql.
-- Paired listings keep feedback in Marketplace; these columns stay empty for their proxied orders.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "rating" integer,
  ADD COLUMN IF NOT EXISTS "review" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "feedback_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "merchant_response" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_responded_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "orders_business_feedback_idx"
  ON public.orders USING btree ("business_id", "feedback_at");
