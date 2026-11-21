-- Local payment attempt ledger for unpaired outlets. Paired outlets remain
-- Marketplace-owned. Matches drizzle/0019_payment_ledger.sql; server-owned only.
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS payment_attempt_id uuid;
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS amount_paise integer;
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS failure_code text NOT NULL DEFAULT '';
ALTER TABLE public.provider_events ADD COLUMN IF NOT EXISTS failure_message text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE cascade,
  provider text NOT NULL DEFAULT 'savour',
  provider_reference text NOT NULL DEFAULT '',
  amount_paise integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'created',
  failure_code text NOT NULL DEFAULT '',
  failure_message text NOT NULL DEFAULT '',
  first_event_id text NOT NULL DEFAULT '',
  last_event_id text NOT NULL DEFAULT '',
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_events_attempt_idx ON public.provider_events (payment_attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_order_reference_idx ON public.payment_attempts (business_id, order_id, provider_reference);
CREATE INDEX IF NOT EXISTS payment_attempts_business_created_idx ON public.payment_attempts (business_id, created_at);
CREATE INDEX IF NOT EXISTS payment_attempts_business_status_idx ON public.payment_attempts (business_id, status, created_at);

ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['payment_attempts'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
