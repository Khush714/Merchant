import { createHash, timingSafeEqual } from "node:crypto";
import { Client } from "pg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAME = "20261123000000_service_config.sql + 20261124000000_supabase_rls.sql";
const ONE_TIME_TOKEN = "1d8473b7fb629a908567ed5615397792";

// Idempotent form matching supabase/migrations/20261123000000_service_config.sql
// and supabase/migrations/20261124000000_supabase_rls.sql.
const MIGRATION_SQL = `
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS delivery_radius_meters integer NOT NULL DEFAULT 3000;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS delivery_zones jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS weekly_hours jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS day_parts jsonb NOT NULL DEFAULT '[]'::jsonb;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
do $$
declare
  tbl record;
begin
  for tbl in select schemaname, tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I.%I enable row level security', tbl.schemaname, tbl.tablename);
    execute format('revoke all on table %I.%I from public, anon, authenticated, service_role', tbl.schemaname, tbl.tablename);
  end loop;
end
$$;
do $$
declare
  seq record;
begin
  for seq in select sequence_schema, sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('revoke all on sequence %I.%I from public, anon, authenticated, service_role', seq.sequence_schema, seq.sequence_name);
  end loop;
end
$$;
`.trim();

const CHECKSUM = createHash("sha256").update(MIGRATION_SQL).digest("hex").slice(0, 16);

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

const COLUMNS = [
  "latitude", "longitude", "delivery_radius_meters",
  "delivery_zones", "weekly_hours", "day_parts",
] as const;
const ROLES = ["anon", "authenticated", "service_role"] as const;

const CHECKS = [
  ...COLUMNS.map((column) => ({
    name: `column ${column}`,
    sql: `select 1 from information_schema.columns where table_schema='public' and table_name='businesses' and column_name='${column}'`,
  })),
  {
    name: "rls all public tables",
    sql: `select 1 where not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity)`,
  },
  ...ROLES.map((role) => ({ name: `role ${role}`, sql: `select 1 from pg_roles where rolname='${role}'` })),
] as const;

async function state(client: Client) {
  const results = await Promise.all(CHECKS.map((check) => client.query(check.sql)));
  const present = CHECKS.filter((_, i) => (results[i].rowCount ?? 0) > 0).map((check) => check.name);
  const missing = CHECKS.filter((_, i) => (results[i].rowCount ?? 0) === 0).map((check) => check.name);
  return { present, missing, verified: missing.length === 0, counts: { columns: COLUMNS.length, rls: 1, roles: ROLES.length } };
}

/** Read-only verification of the one-shot production service-config migration. */
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

/** One-shot operator helper for the production service-config migration; removed after use. */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let client: Client;
  try { client = connect(); } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 });
  }
  try {
    await client.connect();
    const before = await state(client);
    if (before.verified) return Response.json({ ok: true, status: "already-applied", checksum: CHECKSUM, state: before }, {
      headers: { "Cache-Control": "no-store" },
    });

    await client.query("begin");
    try {
      await client.query(MIGRATION_SQL);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    return Response.json({ ok: true, status: "applied", checksum: CHECKSUM, state: await state(client) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
