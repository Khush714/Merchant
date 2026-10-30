CREATE TABLE IF NOT EXISTS "business_marketplace_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL UNIQUE REFERENCES "businesses"("id") ON DELETE CASCADE,
  "marketplace_restaurant_id" integer NOT NULL,
  "marketplace_restaurant_name" text NOT NULL,
  "marketplace_restaurant_slug" text NOT NULL,
  "access_token_encrypted" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
