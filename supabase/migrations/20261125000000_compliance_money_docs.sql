-- Outlet-scoped compliance metadata, private document references, versioned
-- agreements and mirrored/pro forma tax invoices. Matches
-- drizzle/0018_compliance_money_docs.sql; file bytes stay in private storage.
CREATE TABLE IF NOT EXISTS public.business_compliance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  legal_name text NOT NULL DEFAULT '',
  entity_type text NOT NULL DEFAULT '',
  gstin text NOT NULL DEFAULT '',
  pan text NOT NULL DEFAULT '',
  tax_regime text NOT NULL DEFAULT 'unregistered',
  tax_inclusive boolean NOT NULL DEFAULT true,
  default_tax_rate_bps integer NOT NULL DEFAULT 0,
  fssai_number text NOT NULL DEFAULT '',
  fssai_expires_at timestamptz,
  kyc_status text NOT NULL DEFAULT 'not_submitted',
  fssai_status text NOT NULL DEFAULT 'not_submitted',
  tax_status text NOT NULL DEFAULT 'not_submitted',
  payout_status text NOT NULL DEFAULT 'not_configured',
  payout_method_label text NOT NULL DEFAULT '',
  payout_reference text NOT NULL DEFAULT '',
  payout_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  kind text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'merchant-compliance',
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  uploaded_by uuid REFERENCES public.users(id) ON DELETE set null,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  content_hash text NOT NULL,
  effective_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compliance_agreement_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  agreement_id uuid NOT NULL REFERENCES public.compliance_agreements(id),
  user_id uuid REFERENCES public.users(id) ON DELETE set null,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text NOT NULL DEFAULT '',
  user_agent_hash text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.tax_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
  invoice_number text NOT NULL,
  source text NOT NULL,
  external_id text NOT NULL DEFAULT '',
  order_id text NOT NULL DEFAULT '',
  settlement_id uuid REFERENCES public.settlements(id) ON DELETE set null,
  recipient_name text NOT NULL DEFAULT '',
  recipient_gstin text NOT NULL DEFAULT '',
  taxable_amount integer NOT NULL DEFAULT 0,
  cgst_amount integer NOT NULL DEFAULT 0,
  sgst_amount integer NOT NULL DEFAULT 0,
  igst_amount integer NOT NULL DEFAULT 0,
  total_amount integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  source_updated_at timestamptz,
  storage_bucket text NOT NULL DEFAULT 'merchant-compliance',
  storage_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_compliance_business_idx ON public.business_compliance (business_id);
CREATE INDEX IF NOT EXISTS compliance_documents_business_idx ON public.compliance_documents (business_id);
CREATE INDEX IF NOT EXISTS compliance_documents_business_kind_idx ON public.compliance_documents (business_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_agreements_version_idx ON public.compliance_agreements (version);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_agreement_acceptances_business_agreement_idx ON public.compliance_agreement_acceptances (business_id, agreement_id);
CREATE INDEX IF NOT EXISTS compliance_agreement_acceptances_business_idx ON public.compliance_agreement_acceptances (business_id);
CREATE INDEX IF NOT EXISTS tax_invoices_business_issued_idx ON public.tax_invoices (business_id, issued_at);
CREATE INDEX IF NOT EXISTS tax_invoices_business_external_idx ON public.tax_invoices (business_id, source, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_invoices_business_invoice_idx ON public.tax_invoices (business_id, invoice_number);

-- Server-owned: browsers never connect to Postgres.
ALTER TABLE public.business_compliance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_agreement_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_invoices ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'business_compliance', 'compliance_documents', 'compliance_agreements',
    'compliance_agreement_acceptances', 'tax_invoices'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
