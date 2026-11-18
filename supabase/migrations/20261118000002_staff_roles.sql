-- Staff memberships with soft removal, matching drizzle/0010_staff_roles.sql.
-- Roles and their permissions live in the application (src/lib/roles.ts).
CREATE TABLE IF NOT EXISTS public.staff_members (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES public.businesses("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES public.users("id") ON DELETE CASCADE,
  "role" text DEFAULT 'server' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "invited_by" uuid REFERENCES public.users("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_business_user_idx"
  ON public.staff_members USING btree ("business_id", "user_id");
CREATE INDEX IF NOT EXISTS "staff_user_idx"
  ON public.staff_members USING btree ("user_id");
