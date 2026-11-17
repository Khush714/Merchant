-- Authoritative settlement mirror fields, matching drizzle/0006_settlement_sync.sql.
-- Marketplace owns the payout and destination account; this table only stores the net result.
ALTER TABLE public.business_marketplace_links
  ADD COLUMN IF NOT EXISTS "settlement_sync_attempted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "settlements_synced_at" timestamp with time zone;

ALTER TABLE public.settlements
  ADD COLUMN IF NOT EXISTS "external_id" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "marketplace_order_id" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "order_number" integer,
  ADD COLUMN IF NOT EXISTS "gross_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "commission_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "adjustment_amount" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'INR' NOT NULL,
  ADD COLUMN IF NOT EXISTS "source_updated_at" timestamp with time zone;

-- Legacy rows have no external identity; their primary key is a safe one-off stand-in.
UPDATE public.settlements
SET "external_id" = "id"::text, "marketplace_order_id" = "id"::text
WHERE "external_id" = '' OR "marketplace_order_id" = '';

CREATE UNIQUE INDEX IF NOT EXISTS "settlements_business_external_idx"
  ON public.settlements USING btree ("business_id", "external_id");
CREATE UNIQUE INDEX IF NOT EXISTS "settlements_business_order_idx"
  ON public.settlements USING btree ("business_id", "marketplace_order_id");
