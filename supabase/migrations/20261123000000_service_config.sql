-- Merchant-configured map location, delivery areas, recurring weekly hours and day-part menus.
-- These columns are outlet-scoped because they live on the businesses row.
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS delivery_radius_meters integer NOT NULL DEFAULT 3000;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS delivery_zones jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS weekly_hours jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS day_parts jsonb NOT NULL DEFAULT '[]'::jsonb;
