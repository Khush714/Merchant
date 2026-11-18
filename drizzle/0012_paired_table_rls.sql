-- Paired-listing tables are server-owned: browsers never connect to Postgres.
-- RLS with no permissive policies limits access to the table owner/service role.
ALTER TABLE public.business_marketplace_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.staff_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.provider_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['business_marketplace_links', 'offers', 'staff_members', 'provider_events'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
