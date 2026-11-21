ALTER TABLE "provider_events" ADD COLUMN "payment_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "amount_paise" integer;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "failure_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "failure_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE TABLE "payment_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "provider" text DEFAULT 'savour' NOT NULL,
  "provider_reference" text DEFAULT '' NOT NULL,
  "amount_paise" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "status" text DEFAULT 'created' NOT NULL,
  "failure_code" text DEFAULT '' NOT NULL,
  "failure_message" text DEFAULT '' NOT NULL,
  "first_event_id" text DEFAULT '' NOT NULL,
  "last_event_id" text DEFAULT '' NOT NULL,
  "last_event_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "provider_events_attempt_idx" ON "provider_events" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_order_reference_idx" ON "payment_attempts" USING btree ("business_id","order_id","provider_reference");--> statement-breakpoint
CREATE INDEX "payment_attempts_business_created_idx" ON "payment_attempts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_business_status_idx" ON "payment_attempts" USING btree ("business_id","status","created_at");--> statement-breakpoint
ALTER TABLE "payment_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
