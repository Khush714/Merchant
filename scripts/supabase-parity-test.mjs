import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * The app deploys through `supabase db push` (supabase/migrations/) but tests and
 * runs locally through drizzle/*.sql. Both histories must build the same schema.
 *
 * Two layers of checks:
 *  1. Text footprints and the journal pair map (no database needed).
 *  2. Fresh throwaway databases built from each history, then a comparison of the
 *     resulting PostgreSQL catalog definitions: columns, types, defaults,
 *     nullability, constraints (including FK actions), indexes, policies, RLS
 *     flags, ACLs, extensions and any routines/triggers/views/sequences/types.
 *
 * Generated constraint and index names are normalised because Drizzle and
 * Supabase name them differently; the definitions and behaviour must still match.
 */
loadEnv({ path: ".env.local", quiet: true });

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const drizzleDir = join(root, "drizzle");
const supabaseDir = join(root, "supabase/migrations");

// The first migrations were hand-named before the two histories were aligned.
const PAIRS = [
  ["0000_absent_ares", "20261027000000_initial_schema"],
  ["0001_funny_legion", "20261027000001_delivery_address"],
  ["0002_marketplace_link", "20261028000000_marketplace_bridge"],
  ["0003_unique_marketplace_restaurant", "20261029000000_marketplace_restaurant_unique"],
  ["0004_security_audit_log", "20261117000000_security_audit_log"],
  ["0005_email_account_tokens", "20261117000001_email_account_tokens"],
  ["0006_settlement_sync", "20261117000002_settlement_sync"],
  ["0007_audit_reader", "20261117000003_audit_reader"],
  ["0008_order_feedback", "20261118000000_order_feedback"],
  ["0009_offers", "20261118000001_offers"],
  ["0010_staff_roles", "20261118000002_staff_roles"],
  ["0011_provider_events", "20261118000003_provider_events"],
  ["0012_paired_table_rls", "20261118000004_paired_table_rls"],
  ["0013_temporary_closure", "20261119000005_temporary_closure"],
  ["0014_menu_modifiers_stock", "20261121000000_menu_modifiers_stock"],
  ["0015_multi_outlet", "20261122000000_multi_outlet"],
  ["0016_service_config", "20261123000000_service_config"],
  ["0017_supabase_rls", "20261124000000_supabase_rls"],
  ["0018_compliance_money_docs", "20261125000000_compliance_money_docs"],
];

// Supabase only: a superseded OAuth experiment that the next bridge migration drops.
const SUPABASE_ONLY = new Set(["20261027000002_marketplace_link.sql"]);
const LEGACY_NAMES = new Set([
  "marketplace_session_cipher",
  "marketplace_session_expires_at",
  "businesses_marketplace_restaurant_id_unique",
]);
const COLUMN_TYPE = "uuid|text|integer|boolean|double precision|timestamp with time zone|timestamptz|timestamp|jsonb|serial|bigint|numeric";

function footprint(files) {
  const sql = files.map((file) => readFileSync(file, "utf8")).join("\n")
    .replace(/--[^\n]*/g, " ")
    .toLowerCase()
    .replace(/\bpublic\./g, "")
    .replace(/"/g, "")
    .replace(/\s+/g, " ");
  const collect = (pattern) => new Set([...sql.matchAll(pattern)].map((match) => match[1]));
  return {
    tables: collect(/\bcreate table (?:if not exists )?([\w]+)/g),
    columns: collect(new RegExp(`\\b([a-z_]+)\\s+(?:${COLUMN_TYPE})\\b`, "g")),
    addedColumns: collect(/\badd column (?:if not exists )?([\w]+)/g),
    indexes: collect(/\bcreate (?:unique )?index (?:if not exists )?([\w]+)/g),
    text: sql,
  };
}

function withoutLegacy(names) {
  return [...names].filter((name) => !LEGACY_NAMES.has(name)).sort();
}

const journal = JSON.parse(readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"));
assert.deepEqual(journal.entries.map((entry) => entry.tag), PAIRS.map(([tag]) => tag), "drizzle journal and migration pair map must agree");
assert.ok(
  journal.entries.every((entry, index) => index === 0 || Number(entry.when) > Number(journal.entries[index - 1].when)),
  "drizzle journal timestamps must strictly increase or the migrator can skip a later migration",
);

const supabaseFiles = readdirSync(supabaseDir).filter((name) => name.endsWith(".sql")).sort();
assert.deepEqual(
  supabaseFiles,
  PAIRS.map(([, name]) => `${name}.sql`).concat([...SUPABASE_ONLY]).sort(),
  "Supabase and drizzle migrations must be paired",
);

const drizzleFootprint = footprint(PAIRS.map(([tag]) => join(drizzleDir, `${tag}.sql`)));
const supabaseFootprint = footprint(PAIRS.map(([, name]) => join(supabaseDir, `${name}.sql`)));
for (const key of ["tables", "columns", "addedColumns", "indexes"]) {
  assert.deepEqual(
    withoutLegacy(drizzleFootprint[key]),
    withoutLegacy(supabaseFootprint[key]),
    `schema drift in ${key}`,
  );
}

for (const column of ["latitude", "longitude", "delivery_radius_meters", "delivery_zones", "weekly_hours", "day_parts"]) {
  assert.ok(drizzleFootprint.addedColumns.has(column) && supabaseFootprint.addedColumns.has(column), `${column} must exist on both paths`);
}

for (const [side, text] of [["drizzle", drizzleFootprint.text], ["supabase", supabaseFootprint.text]]) {
  for (const marker of ["enable row level security", "revoke all", "anon", "authenticated", "service_role"]) {
    assert.ok(text.includes(marker), `${side} migrations are missing security marker: ${marker}`);
  }
}

assert.equal(
  readFileSync(join(drizzleDir, "0017_supabase_rls.sql"), "utf8"),
  readFileSync(join(supabaseDir, "20261124000000_supabase_rls.sql"), "utf8"),
  "the RLS hardening migration must be identical on both paths",
);

// --- Fresh-database catalog comparison ---------------------------------------------------------

const CATALOG_QUERIES = {
  tables: "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
  columns: `select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default, a.attidentity as identity,
      a.attgenerated as generated, (select collname from pg_collation where oid = a.attcollation) as collation,
      col_description(a.attrelid, a.attnum) as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind in ('r', 'p')`,
  // pg_get_constraintdef carries the full FK action / check expression / PK columns.
  // Names are omitted: the two histories generate different names for identical constraints.
  constraints: `select conrelid::regclass::text as table, contype, pg_get_constraintdef(oid) as definition,
      condeferrable, condeferred, convalidated
    from pg_constraint where connamespace = 'public'::regnamespace`,
  // Strip the generated index name but keep uniqueness, method, columns, opclasses and predicates.
  indexes: `select tablename,
      regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON ', 'CREATE \\1INDEX ON ') as definition
    from pg_indexes where schemaname = 'public'`,
  policies: `select tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public'`,
  triggers: `select event_object_table, trigger_name, action_timing, event_manipulation, action_statement
    from information_schema.triggers where trigger_schema = 'public'`,
  routines: `select routine_name, data_type, routine_definition, external_language
    from information_schema.routines where routine_schema = 'public'`,
  otherRelations: `select relname, relkind from pg_class
    where relnamespace = 'public'::regnamespace and relkind in ('v', 'm', 'S')`,
  // Indexes are excluded here; their definitions are compared above.
  relationSecurity: `select relname, relkind, relrowsecurity, relforcerowsecurity, relacl::text
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S')`,
  extensions: "select extname, extversion from pg_extension",
  types: `select t.typname, t.typtype, format_type(t.oid, null) as fmt
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('e', 'd')`,
};

function localConnectionString() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Fresh-database parity introspection requires a local DATABASE_URL.");
  const parsed = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Refusing to create throwaway parity databases on a non-local DATABASE_URL.");
  }
  return connectionString;
}

async function withFreshDatabase(name, connectionString, callback) {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const scopedUrl = new URL(connectionString);
  scopedUrl.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    const client = new Client({ connectionString: scopedUrl.toString() });
    await client.connect();
    try { return await callback(client); }
    finally { await client.end().catch(() => {}); }
  } finally {
    try { await admin.query(`drop database if exists ${name} with (force)`); }
    finally { await admin.end(); }
  }
}

async function applyAndIntrospect(client, files) {
  for (const file of files) await client.query(readFileSync(file, "utf8"));
  const snapshot = {};
  for (const [key, sql] of Object.entries(CATALOG_QUERIES)) {
    const { rows } = await client.query(sql);
    snapshot[key] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return snapshot;
}

const connectionString = localConnectionString();
const suffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
const drizzleFiles = PAIRS.map(([tag]) => join(drizzleDir, `${tag}.sql`));
const supabaseFilesInOrder = [...PAIRS.map(([, name]) => `${name}.sql`), ...SUPABASE_ONLY].sort()
  .map((name) => join(supabaseDir, name));

const drizzleCatalog = await withFreshDatabase(
  `parity_drizzle_${suffix}`,
  connectionString,
  (client) => applyAndIntrospect(client, drizzleFiles),
);
const supabaseCatalog = await withFreshDatabase(
  `parity_supabase_${suffix}`,
  connectionString,
  (client) => applyAndIntrospect(client, supabaseFilesInOrder),
);

for (const key of Object.keys(CATALOG_QUERIES)) {
  const onlyDrizzle = drizzleCatalog[key].filter((row) => !supabaseCatalog[key].includes(row));
  const onlySupabase = supabaseCatalog[key].filter((row) => !drizzleCatalog[key].includes(row));
  assert.equal(
    onlyDrizzle.length + onlySupabase.length,
    0,
    `catalog drift in ${key}\n  drizzle only:\n    ${onlyDrizzle.join("\n    ")}\n  supabase only:\n    ${onlySupabase.join("\n    ")}`,
  );
}

console.log("PASS: supabase and drizzle migrations stay in sync (text footprint and PostgreSQL catalog)");
