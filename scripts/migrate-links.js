const { Pool } = require('pg');
const fs = require('fs');

// Check command line arguments first, then .env.local
let dbUrl = process.argv[2] || process.env.DATABASE_URL;

if (!dbUrl && fs.existsSync('.env.local')) {
  const content = fs.readFileSync('.env.local', 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('DATABASE_URL=')) {
      dbUrl = trimmed.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
      break;
    }
  }
}

if (!dbUrl) {
  console.error("Error: DATABASE_URL not found. Pass it as an argument: node scripts/migrate-links.js \"postgresql://...\"");
  process.exit(1);
}

const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');

try {
  const parsed = new URL(dbUrl);
  console.log(`Connecting to: ${parsed.host} (${isLocal ? 'Local: No SSL' : 'Cloud: SSL Enabled'})`);
} catch {}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("Creating table business_marketplace_links if not exists...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_marketplace_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
        marketplace_restaurant_id integer NOT NULL,
        marketplace_restaurant_name text NOT NULL,
        marketplace_restaurant_slug text NOT NULL,
        access_token_encrypted text NOT NULL,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now()
      );
    `);
    
    console.log("Creating unique index unique_marketplace_restaurant_idx...");
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_marketplace_restaurant_idx 
      ON business_marketplace_links (marketplace_restaurant_id);
    `);

    // Match the migrations: no Data API role may read this table directly.
    console.log("Applying row-level security and revoking Data API roles...");
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
      END
      $$;
      ALTER TABLE business_marketplace_links ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE business_marketplace_links FROM PUBLIC, anon, authenticated, service_role;
    `);

    console.log("✅ Success! Table business_marketplace_links, unique index and RLS are ready.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
