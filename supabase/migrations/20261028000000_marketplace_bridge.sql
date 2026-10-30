-- Switch the Marketplace integration from per-restaurant OAuth sessions to the
-- Merchant App pairing bridge. The per-business bearer token is stored encrypted.
ALTER TABLE public.businesses
  DROP COLUMN IF EXISTS marketplace_session_cipher,
  DROP COLUMN IF EXISTS marketplace_session_expires_at,
  DROP COLUMN IF EXISTS marketplace_restaurant_id;
--> statement-breakpoint
DROP INDEX IF EXISTS businesses_marketplace_restaurant_id_unique;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.business_marketplace_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL UNIQUE REFERENCES public.businesses (id) ON DELETE CASCADE,
  marketplace_restaurant_id integer NOT NULL,
  marketplace_restaurant_name text NOT NULL,
  marketplace_restaurant_slug text NOT NULL,
  access_token_encrypted text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
