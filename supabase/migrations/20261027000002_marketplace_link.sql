ALTER TABLE public.businesses
  ADD COLUMN marketplace_restaurant_id integer,
  ADD COLUMN marketplace_session_cipher text,
  ADD COLUMN marketplace_session_expires_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX businesses_marketplace_restaurant_id_unique
  ON public.businesses (marketplace_restaurant_id)
  WHERE marketplace_restaurant_id IS NOT NULL;
