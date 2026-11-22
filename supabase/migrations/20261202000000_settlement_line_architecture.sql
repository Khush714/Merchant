-- Supabase mirror of drizzle/0025_settlement_line_architecture.sql.
-- Additive only: no financial rows are deleted or rewritten.
ALTER TABLE public.settlement_lines
  ADD COLUMN IF NOT EXISTS "line_version" text DEFAULT 'legacy' NOT NULL,
  ADD COLUMN IF NOT EXISTS "fee_schedule_id" uuid REFERENCES public.fee_schedules("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "source_updated_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "rebuilt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "expected_net_paise" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "matches_authoritative" boolean DEFAULT true NOT NULL;

ALTER TABLE public.settlement_statements
  ADD COLUMN IF NOT EXISTS "line_snapshot" jsonb;

UPDATE public.settlement_lines AS l
SET "expected_net_paise" = l."gross_paise" - l."commission_paise" - l."refund_paise" + l."adjustment_paise";

UPDATE public.settlement_lines AS l
SET "matches_authoritative" = (l."net_paise" = l."expected_net_paise");

UPDATE public.settlement_lines AS l
SET "source_updated_at" = s."source_updated_at"
FROM public.settlements AS s
WHERE l."settlement_id" = s."id" AND l."source_updated_at" IS NULL;
