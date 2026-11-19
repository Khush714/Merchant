import { createHash, timingSafeEqual } from "node:crypto";
import { Client } from "pg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAME = "20261121000000_menu_modifiers_stock.sql";
const CHECKSUM = "49503bb0b6ebd9d2";
const ONE_TIME_TOKEN = "a824741e0ab300ac7149224a77c7f135";

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!supplied) return false;
  const a = createHash("sha256").update(ONE_TIME_TOKEN).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}

function connect() {
  const url = (process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!url) throw new Error("No migrations database");
  return new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
}

const OBJECTS = [
  { kind: "column", name: "menu_items.stock_quantity" },
  { kind: "table", name: "menu_modifier_groups" },
  { kind: "table", name: "menu_modifier_options" },
  { kind: "table", name: "menu_item_modifier_groups" },
] as const;

async function state(client: Client) {
  const checks = await Promise.all(
    OBJECTS.map((object) =>
      object.kind === "column"
        ? client.query(
            `select 1 from information_schema.columns
              where table_schema='public' and table_name='menu_items' and column_name='stock_quantity'`,
          )
        : client.query(
            `select 1 from information_schema.tables where table_schema='public' and table_name=$1`,
            [object.name],
          ),
    ),
  );
  const present = OBJECTS.filter((_, i) => (checks[i].rowCount ?? 0) > 0).map((o) => o.name);
  const missing = OBJECTS.filter((_, i) => (checks[i].rowCount ?? 0) === 0).map((o) => o.name);
  return { present, missing, verified: missing.length === 0 };
}

/** Read-only verification of the one-shot production menu-modifier migration. */
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let client: Client;
  try { client = connect(); } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 });
  }
  try {
    await client.connect();
    return Response.json({ ok: true, migration: NAME, checksum: CHECKSUM, state: await state(client) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** One-shot operator helper for the production menu-modifier migration; removed after use. */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let client: Client;
  try { client = connect(); } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 });
  }
  try {
    await client.connect();
    const before = await state(client);
    if (before.verified) return Response.json({ ok: true, status: "already-applied", state: before });

    await client.query("begin");
    try {
      await client.query(`
        ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS stock_quantity integer;

        CREATE TABLE IF NOT EXISTS public.menu_modifier_groups (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
          name text NOT NULL,
          min_select integer NOT NULL DEFAULT 0,
          max_select integer NOT NULL DEFAULT 1,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS public.menu_modifier_options (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          group_id uuid NOT NULL REFERENCES public.menu_modifier_groups(id) ON DELETE cascade,
          business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
          name text NOT NULL,
          price_cents integer NOT NULL DEFAULT 0,
          is_veg boolean NOT NULL DEFAULT true,
          available boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS public.menu_item_modifier_groups (
          menu_item_id uuid NOT NULL REFERENCES public.menu_items(id) ON DELETE cascade,
          modifier_group_id uuid NOT NULL REFERENCES public.menu_modifier_groups(id) ON DELETE cascade,
          business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE cascade,
          CONSTRAINT menu_item_modifier_groups_pkey PRIMARY KEY (menu_item_id, modifier_group_id)
        );

        CREATE INDEX IF NOT EXISTS menu_mod_groups_business_idx ON public.menu_modifier_groups (business_id);
        CREATE INDEX IF NOT EXISTS menu_mod_options_group_idx ON public.menu_modifier_options (group_id);
        CREATE INDEX IF NOT EXISTS menu_item_mod_groups_business_idx ON public.menu_item_modifier_groups (business_id);

        ALTER TABLE public.menu_modifier_groups ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.menu_modifier_options ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;

        DO $$
        DECLARE
          target_table text;
          client_role text;
        BEGIN
          FOREACH target_table IN ARRAY ARRAY['menu_modifier_groups', 'menu_modifier_options', 'menu_item_modifier_groups'] LOOP
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', target_table);
            FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
              IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
                EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', target_table, client_role);
              END IF;
            END LOOP;
          END LOOP;
        END $$;
      `);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    return Response.json({ ok: true, status: "applied", state: await state(client) });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
