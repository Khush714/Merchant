import { createHash, timingSafeEqual } from "node:crypto";
import { Client } from "pg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAME = "20261122000000_multi_outlet.sql";
const CHECKSUM = "a7d64cd389d93abe";
const ONE_TIME_TOKEN = "fb162caca90bc2b70b231f942f77e4d7";

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

const CHECKS = [
  {
    name: "businesses_owner_id_unique removed",
    sql: `select 1 where not exists (
      select 1 from pg_constraint
      where conrelid='public.businesses'::regclass and conname='businesses_owner_id_unique'
    )`,
  },
  {
    name: "businesses_owner_idx exists",
    sql: `select 1 from pg_indexes
      where schemaname='public' and tablename='businesses' and indexname='businesses_owner_idx'`,
  },
  {
    name: "sessions.active_business_id exists",
    sql: `select 1 from information_schema.columns
      where table_schema='public' and table_name='sessions' and column_name='active_business_id'`,
  },
  {
    name: "sessions_active_business_id_fkey exists",
    sql: `select 1 from pg_constraint
      where conrelid='public.sessions'::regclass and conname='sessions_active_business_id_fkey' and contype='f'`,
  },
] as const;

async function state(client: Client) {
  const results = await Promise.all(CHECKS.map((check) => client.query(check.sql)));
  const present = CHECKS.filter((_, i) => (results[i].rowCount ?? 0) > 0).map((check) => check.name);
  const missing = CHECKS.filter((_, i) => (results[i].rowCount ?? 0) === 0).map((check) => check.name);
  return { present, missing, verified: missing.length === 0 };
}

/** Read-only verification of the one-shot production multi-outlet migration. */
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

/** One-shot operator helper for the production multi-outlet migration; removed after use. */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  let client: Client;
  try { client = connect(); } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 503 });
  }
  try {
    await client.connect();
    const before = await state(client);
    if (before.verified) return Response.json({ ok: true, status: "already-applied", state: before }, {
      headers: { "Cache-Control": "no-store" },
    });

    await client.query("begin");
    try {
      await client.query(`
        ALTER TABLE public.businesses DROP CONSTRAINT IF EXISTS businesses_owner_id_unique;

        CREATE INDEX IF NOT EXISTS businesses_owner_idx ON public.businesses USING btree (owner_id);

        ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS active_business_id uuid;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='public.sessions'::regclass and conname='sessions_active_business_id_fkey'
          ) THEN
            ALTER TABLE public.sessions
              ADD CONSTRAINT sessions_active_business_id_fkey
              FOREIGN KEY (active_business_id) REFERENCES public.businesses(id) ON DELETE set null;
          END IF;
        END
        $$;

        UPDATE public.sessions SET active_business_id = owner_business.id
        FROM (
          SELECT DISTINCT ON (owner_id) owner_id, id
          FROM public.businesses
          ORDER BY owner_id, id
        ) AS owner_business
        WHERE owner_business.owner_id = public.sessions.user_id
          AND public.sessions.active_business_id IS NULL;
      `);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    return Response.json({ ok: true, status: "applied", state: await state(client) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
