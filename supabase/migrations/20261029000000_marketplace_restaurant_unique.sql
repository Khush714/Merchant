-- Keep the pairing bridge's one-to-one Marketplace restaurant guarantee in sync with src/db/schema.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_marketplace_restaurant_idx"
  ON public.business_marketplace_links USING btree ("marketplace_restaurant_id");
