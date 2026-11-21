CREATE TABLE "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "payment_attempt_id" uuid REFERENCES "payment_attempts"("id") ON DELETE set null,
  "amount_paise" integer NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'requested' NOT NULL,
  "provider_refund_id" text DEFAULT '' NOT NULL,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "cancellations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "refund_id" uuid REFERENCES "refunds"("id") ON DELETE set null,
  "reason" text DEFAULT '' NOT NULL,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "fee_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid REFERENCES "businesses"("id") ON DELETE cascade,
  "effective_from" timestamp with time zone NOT NULL,
  "commission_bps" integer DEFAULT 0 NOT NULL,
  "platform_fixed_paise" integer DEFAULT 0 NOT NULL,
  "gateway_bps" integer DEFAULT 0 NOT NULL,
  "gateway_fixed_paise" integer DEFAULT 0 NOT NULL,
  "gst_bps" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "settlement_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "settlement_id" uuid NOT NULL REFERENCES "settlements"("id") ON DELETE cascade,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE set null,
  "payment_attempt_id" uuid REFERENCES "payment_attempts"("id") ON DELETE set null,
  "gross_paise" integer DEFAULT 0 NOT NULL,
  "commission_paise" integer DEFAULT 0 NOT NULL,
  "gateway_fee_paise" integer DEFAULT 0 NOT NULL,
  "tax_paise" integer DEFAULT 0 NOT NULL,
  "refund_paise" integer DEFAULT 0 NOT NULL,
  "adjustment_paise" integer DEFAULT 0 NOT NULL,
  "net_paise" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'marketplace' NOT NULL,
  "source_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "reference" text NOT NULL,
  "method_label" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "amount_paise" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "source" text DEFAULT 'marketplace' NOT NULL,
  "initiated_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "source_updated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "payout_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "payout_id" uuid NOT NULL REFERENCES "payouts"("id") ON DELETE cascade,
  "settlement_id" uuid REFERENCES "settlements"("id") ON DELETE set null,
  "amount_paise" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "settlement_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "number" text NOT NULL,
  "period_from" text NOT NULL,
  "period_to" text NOT NULL,
  "gross_paise" integer DEFAULT 0 NOT NULL,
  "commission_paise" integer DEFAULT 0 NOT NULL,
  "gateway_fee_paise" integer DEFAULT 0 NOT NULL,
  "tax_paise" integer DEFAULT 0 NOT NULL,
  "refund_paise" integer DEFAULT 0 NOT NULL,
  "adjustment_paise" integer DEFAULT 0 NOT NULL,
  "net_paise" integer DEFAULT 0 NOT NULL,
  "line_count" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'closed' NOT NULL,
  "checksum" text DEFAULT '' NOT NULL,
  "line_ids" jsonb DEFAULT '[]' NOT NULL,
  "generated_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" text DEFAULT 'running' NOT NULL,
  "order_count" integer DEFAULT 0 NOT NULL,
  "payment_count" integer DEFAULT 0 NOT NULL,
  "settlement_count" integer DEFAULT 0 NOT NULL,
  "payout_count" integer DEFAULT 0 NOT NULL,
  "exception_count" integer DEFAULT 0 NOT NULL,
  "triggered_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "detail" jsonb DEFAULT '{}' NOT NULL
);--> statement-breakpoint
CREATE TABLE "reconciliation_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL REFERENCES "reconciliation_runs"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "severity" text DEFAULT 'warning' NOT NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE set null,
  "payment_attempt_id" uuid REFERENCES "payment_attempts"("id") ON DELETE set null,
  "settlement_id" uuid REFERENCES "settlements"("id") ON DELETE set null,
  "payout_id" uuid REFERENCES "payouts"("id") ON DELETE set null,
  "expected_paise" integer DEFAULT 0 NOT NULL,
  "actual_paise" integer DEFAULT 0 NOT NULL,
  "detail" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "resolution_note" text DEFAULT '' NOT NULL,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "refunds_business_created_idx" ON "refunds" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_idx" ON "refunds" USING btree ("business_id","provider_refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cancellations_order_idx" ON "cancellations" USING btree ("business_id","order_id");--> statement-breakpoint
CREATE INDEX "fee_schedules_business_effective_idx" ON "fee_schedules" USING btree ("business_id","effective_from");--> statement-breakpoint
CREATE INDEX "settlement_lines_business_idx" ON "settlement_lines" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_lines_settlement_idx" ON "settlement_lines" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_order_idx" ON "settlement_lines" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_business_reference_idx" ON "payouts" USING btree ("business_id","reference");--> statement-breakpoint
CREATE INDEX "payouts_business_created_idx" ON "payouts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_allocations_payout_settlement_idx" ON "payout_allocations" USING btree ("payout_id","settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statements_business_number_idx" ON "settlement_statements" USING btree ("business_id","number");--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_business_idx" ON "reconciliation_exceptions" USING btree ("business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_run_idx" ON "reconciliation_exceptions" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cancellations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settlement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payout_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "settlement_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
