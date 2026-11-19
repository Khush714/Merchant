-- Local/demo modifier groups and item stock. Paired listings keep this data in
-- Marketplace; these tables only serve unpaired and sample businesses.
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS stock_quantity integer;

CREATE TABLE IF NOT EXISTS public.menu_modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  name text NOT NULL,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.menu_modifier_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.menu_modifier_groups(id) ON DELETE cascade,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  name text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  is_veg boolean NOT NULL DEFAULT true,
  available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.menu_item_modifier_groups (
  menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE cascade,
  modifier_group_id uuid NOT NULL REFERENCES public.menu_modifier_groups(id) ON DELETE cascade,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  CONSTRAINT menu_item_modifier_groups_pkey PRIMARY KEY (menu_item_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS menu_mod_groups_business_idx ON public.menu_modifier_groups (business_id);
CREATE INDEX IF NOT EXISTS menu_mod_options_group_idx ON public.menu_modifier_options (group_id);
CREATE INDEX IF NOT EXISTS menu_item_mod_groups_business_idx ON public.menu_item_modifier_groups (business_id);

ALTER TABLE public.menu_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['menu_modifier_groups', 'menu_modifier_options', 'menu_item_modifier_groups'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
