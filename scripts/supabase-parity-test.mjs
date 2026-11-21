import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The app deploys through `supabase db push` (supabase/migrations/) but tests and
 * runs locally through drizzle/*.sql. Both histories must build the same schema.
 * This check needs no database or credentials: it compares the schema footprint
 * (tables, columns, indexes and constraints) and verifies that both paths end
 * with RLS and Data API revokes.
 */
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
  ["0019_payment_ledger", "20261126000000_payment_ledger"],
  ["0020_financial_operations", "20261127000000_financial_operations"],
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

console.log("PASS: supabase and drizzle migrations stay in sync");
