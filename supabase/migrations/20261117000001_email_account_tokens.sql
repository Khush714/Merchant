-- Hashed, expiring, single-use verification and password reset links,
-- matching drizzle/0005_email_account_tokens.sql.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.account_tokens (
  "token_hash" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES public.users("id") ON DELETE cascade,
  "purpose" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "account_tokens_user_purpose_idx" ON public.account_tokens USING btree ("user_id", "purpose");

ALTER TABLE public.account_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_tokens FROM anon, authenticated;
