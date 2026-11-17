-- Append-only security audit trail, matching drizzle/0004_security_audit_log.sql.
-- Actors, emails, IPs and user agents are stored only as hashes. No application
-- path updates or deletes these rows; pruning is a separate retention decision.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "event" text NOT NULL,
  "outcome" text NOT NULL,
  "request_id" text,
  "actor_user_id" uuid,
  "actor_email_hash" text,
  "business_id" uuid,
  "ip_hash" text,
  "user_agent_hash" text,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON public.audit_logs USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_event_created_at_idx" ON public.audit_logs USING btree ("event", "created_at");

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_logs FROM anon, authenticated;
