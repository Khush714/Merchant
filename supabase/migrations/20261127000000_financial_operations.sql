-- Refund, cancellation, fee, payout, statement and reconciliation records. All money is
-- integer paise and every table is server-owned. Matches drizzle/0020_financial_operations.sql.
CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE cascade,
  payment_attempt_id uuid REFERENCES public.payment_attempts(id) ON DELETE set null,
  amount_paise integer NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'requested',
  provider_refund_id text NOT NULL DEFAULT '',
  requested_by uuid REFERENCES public.users(id) ON DELETE set null,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE set null,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE cascade,
  refund_id uuid REFERENCES public.refunds(id) ON DELETE set null,
  reason text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES public.users(id) ON DELETE set null,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fee_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE cascade,
  effective_from timestamptz NOT NULL,
  commission_bps integer NOT NULL DEFAULT 0,
  platform_fixed_paise integer NOT NULL DEFAULT 0,
  gateway_bps integer NOT NULL DEFAULT 0,
  gateway_fixed_paise integer NOT NULL DEFAULT 0,
  gst_bps integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  settlement_id uuid NOT NULL REFERENCES public.settlements(id) ON DELETE cascade,
  order_id uuid REFERENCES public.orders(id) ON DELETE set null,
  payment_attempt_id uuid REFERENCES public.payment_attempts(id) ON DELETE set null,
  gross_paise integer NOT NULL DEFAULT 0,
  commission_paise integer NOT NULL DEFAULT 0,
  gateway_fee_paise integer NOT NULL DEFAULT 0,
  tax_paise integer NOT NULL DEFAULT 0,
  refund_paise integer NOT NULL DEFAULT 0,
  adjustment_paise integer NOT NULL DEFAULT 0,
  net_paise integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'marketplace',
  source_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  reference text NOT NULL,
  method_label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled',
  amount_paise integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  source text NOT NULL DEFAULT 'marketplace',
  initiated_at timestamptz,
  completed_at timestamptz,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payout_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  payout_id uuid NOT NULL REFERENCES public.payouts(id) ON DELETE cascade,
  settlement_id uuid REFERENCES public.settlements(id) ON DELETE set null,
  amount_paise integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.settlement_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  number text NOT NULL,
  period_from text NOT NULL,
  period_to text NOT NULL,
  gross_paise integer NOT NULL DEFAULT 0,
  commission_paise integer NOT NULL DEFAULT 0,
  gateway_fee_paise integer NOT NULL DEFAULT 0,
  tax_paise integer NOT NULL DEFAULT 0,
  refund_paise integer NOT NULL DEFAULT 0,
  adjustment_paise integer NOT NULL DEFAULT 0,
  net_paise integer NOT NULL DEFAULT 0,
  line_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'closed',
  checksum text NOT NULL DEFAULT '',
  line_ids jsonb NOT NULL DEFAULT '[]',
  generated_by uuid REFERENCES public.users(id) ON DELETE set null,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  order_count integer NOT NULL DEFAULT 0,
  payment_count integer NOT NULL DEFAULT 0,
  settlement_count integer NOT NULL DEFAULT 0,
  payout_count integer NOT NULL DEFAULT 0,
  exception_count integer NOT NULL DEFAULT 0,
  triggered_by uuid REFERENCES public.users(id) ON DELETE set null,
  detail jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS public.reconciliation_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  run_id uuid NOT NULL REFERENCES public.reconciliation_runs(id) ON DELETE cascade,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  order_id uuid REFERENCES public.orders(id) ON DELETE set null,
  payment_attempt_id uuid REFERENCES public.payment_attempts(id) ON DELETE set null,
  settlement_id uuid REFERENCES public.settlements(id) ON DELETE set null,
  payout_id uuid REFERENCES public.payouts(id) ON DELETE set null,
  expected_paise integer NOT NULL DEFAULT 0,
  actual_paise integer NOT NULL DEFAULT 0,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  resolution_note text NOT NULL DEFAULT '',
  resolved_by uuid REFERENCES public.users(id) ON DELETE set null,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS refunds_business_created_idx ON public.refunds (business_id, created_at);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON public.refunds (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_idx ON public.refunds (business_id, provider_refund_id);
CREATE UNIQUE INDEX IF NOT EXISTS cancellations_order_idx ON public.cancellations (business_id, order_id);
CREATE INDEX IF NOT EXISTS fee_schedules_business_effective_idx ON public.fee_schedules (business_id, effective_from);
CREATE INDEX IF NOT EXISTS settlement_lines_business_idx ON public.settlement_lines (business_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_lines_settlement_idx ON public.settlement_lines (settlement_id);
CREATE INDEX IF NOT EXISTS settlement_lines_order_idx ON public.settlement_lines (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS payouts_business_reference_idx ON public.payouts (business_id, reference);
CREATE INDEX IF NOT EXISTS payouts_business_created_idx ON public.payouts (business_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS payout_allocations_payout_settlement_idx ON public.payout_allocations (payout_id, settlement_id);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_statements_business_number_idx ON public.settlement_statements (business_id, number);
CREATE INDEX IF NOT EXISTS reconciliation_exceptions_business_idx ON public.reconciliation_exceptions (business_id, status, created_at);
CREATE INDEX IF NOT EXISTS reconciliation_exceptions_run_idx ON public.reconciliation_exceptions (run_id);

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_exceptions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['refunds', 'cancellations', 'fee_schedules', 'settlement_lines', 'payouts', 'payout_allocations', 'settlement_statements', 'reconciliation_runs', 'reconciliation_exceptions'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
