-- Restricted read access to the append-only audit trail, matching drizzle/0007_audit_reader.sql.
-- NOLOGIN keeps this a group role: grant it to a dedicated login role outside migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO audit_reader;
REVOKE ALL ON TABLE public.audit_logs FROM audit_reader;
GRANT SELECT ON TABLE public.audit_logs TO audit_reader;

-- RLS is enabled on audit_logs with no broad policies; this one is scoped to the group role.
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
