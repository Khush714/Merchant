-- Restricted read access to the append-only audit trail. The role is group-only:
-- grant it to a dedicated login role outside migrations; it cannot insert, update or delete.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO audit_reader;--> statement-breakpoint
REVOKE ALL ON TABLE public.audit_logs FROM audit_reader;--> statement-breakpoint
GRANT SELECT ON TABLE public.audit_logs TO audit_reader;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_reader_select'
  ) THEN
    CREATE POLICY audit_reader_select ON public.audit_logs FOR SELECT TO audit_reader USING (true);
  END IF;
END
$$;
