CREATE TABLE "business_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"legal_name" text DEFAULT '' NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"gstin" text DEFAULT '' NOT NULL,
	"pan" text DEFAULT '' NOT NULL,
	"tax_regime" text DEFAULT 'unregistered' NOT NULL,
	"tax_inclusive" boolean DEFAULT true NOT NULL,
	"default_tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"fssai_number" text DEFAULT '' NOT NULL,
	"fssai_expires_at" timestamp with time zone,
	"kyc_status" text DEFAULT 'not_submitted' NOT NULL,
	"fssai_status" text DEFAULT 'not_submitted' NOT NULL,
	"tax_status" text DEFAULT 'not_submitted' NOT NULL,
	"payout_status" text DEFAULT 'not_configured' NOT NULL,
	"payout_method_label" text DEFAULT '' NOT NULL,
	"payout_reference" text DEFAULT '' NOT NULL,
	"payout_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"user_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" text DEFAULT '' NOT NULL,
	"user_agent_hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_bucket" text DEFAULT 'merchant-compliance' NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"uploaded_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text DEFAULT '' NOT NULL,
	"order_id" text DEFAULT '' NOT NULL,
	"settlement_id" uuid,
	"recipient_name" text DEFAULT '' NOT NULL,
	"recipient_gstin" text DEFAULT '' NOT NULL,
	"taxable_amount" integer DEFAULT 0 NOT NULL,
	"cgst_amount" integer DEFAULT 0 NOT NULL,
	"sgst_amount" integer DEFAULT 0 NOT NULL,
	"igst_amount" integer DEFAULT 0 NOT NULL,
	"total_amount" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_updated_at" timestamp with time zone,
	"storage_bucket" text DEFAULT 'merchant-compliance' NOT NULL,
	"storage_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_compliance" ADD CONSTRAINT "business_compliance_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_agreement_acceptances" ADD CONSTRAINT "compliance_agreement_acceptances_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_agreement_acceptances" ADD CONSTRAINT "compliance_agreement_acceptances_agreement_id_compliance_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."compliance_agreements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_agreement_acceptances" ADD CONSTRAINT "compliance_agreement_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_compliance_business_idx" ON "business_compliance" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_agreement_acceptances_business_agreement_idx" ON "compliance_agreement_acceptances" USING btree ("business_id","agreement_id");--> statement-breakpoint
CREATE INDEX "compliance_agreement_acceptances_business_idx" ON "compliance_agreement_acceptances" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_agreements_version_idx" ON "compliance_agreements" USING btree ("version");--> statement-breakpoint
CREATE INDEX "compliance_documents_business_idx" ON "compliance_documents" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "compliance_documents_business_kind_idx" ON "compliance_documents" USING btree ("business_id","kind");--> statement-breakpoint
CREATE INDEX "tax_invoices_business_issued_idx" ON "tax_invoices" USING btree ("business_id","issued_at");--> statement-breakpoint
CREATE INDEX "tax_invoices_business_external_idx" ON "tax_invoices" USING btree ("business_id","source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_business_invoice_idx" ON "tax_invoices" USING btree ("business_id","invoice_number");

-- Server-owned: browsers never connect to Postgres.
ALTER TABLE "business_compliance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_agreements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "compliance_agreement_acceptances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE
  target_table text;
  client_role text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['business_compliance', 'compliance_documents', 'compliance_agreements', 'compliance_agreement_acceptances', 'tax_invoices'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
    FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
      END IF;
    END LOOP;
  END LOOP;
END
$$;
