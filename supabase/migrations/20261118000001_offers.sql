-- Merchant-created promotions, matching drizzle/0009_offers.sql. Discounts are calculated in
-- the Merchant App order transaction; paired listings keep offers in Marketplace instead.
CREATE TABLE IF NOT EXISTS public.offers (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES public.businesses("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "discount_type" text NOT NULL,
  "value" integer NOT NULL,
  "min_order" integer DEFAULT 0 NOT NULL,
  "max_discount" integer,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "usage_limit" integer,
  "active" boolean DEFAULT true NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS "offer_id" uuid,
  ADD COLUMN IF NOT EXISTS "offer_code" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "discount" integer DEFAULT 0 NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "offers_business_code_idx"
  ON public.offers USING btree ("business_id", "code");
CREATE INDEX IF NOT EXISTS "offers_business_active_idx"
  ON public.offers USING btree ("business_id", "active", "archived");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_offer_id_offers_id_fk') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT "orders_offer_id_offers_id_fk"
      FOREIGN KEY ("offer_id") REFERENCES public.offers("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;
