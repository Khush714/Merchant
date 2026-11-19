-- Temporary closures and planned leave days overlay the merchant's base isOpen
-- switch. Timed closures expire without a cron, and leave dates are India dates.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS closure_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS closure_until timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_leaves jsonb NOT NULL DEFAULT '[]'::jsonb;
