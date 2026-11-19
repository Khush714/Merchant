import assert from "node:assert/strict";
import { prepareDatabaseConnectionString, validateProductionConfig } from "../src/lib/config.ts";

const required = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=require",
  APP_ORIGIN: "https://savour-partner.vercel.app",
  MARKETPLACE_API_URL: "https://marketplace-xyz.vercel.app",
  MERCHANT_APP_INTEGRATION_SECRET: "a".repeat(40),
  MERCHANT_APP_TOKEN_ENCRYPTION_KEY: "b".repeat(40),
};

const valid = validateProductionConfig(required);
assert.deepEqual(valid.errors, [], "the documented production configuration must pass");
assert.ok(valid.ok);
assert.ok(valid.warnings.some((line) => line.includes("Shared rate limiting")), "optional gaps are warnings, not errors");

const ci = validateProductionConfig({
  ...required,
  APP_ORIGIN: "http://127.0.0.1:3000",
  MARKETPLACE_API_URL: "http://127.0.0.1:4100",
  VERCEL: "1",
});
assert.deepEqual(ci.errors, [], "loopback URLs remain valid for local start validation");

const missing = validateProductionConfig({ NODE_ENV: "production" });
for (const key of ["DATABASE_URL", "APP_ORIGIN", "MARKETPLACE_API_URL", "MERCHANT_APP_INTEGRATION_SECRET", "MERCHANT_APP_TOKEN_ENCRYPTION_KEY"]) {
  assert.ok(missing.errors.some((line) => line.includes(key)), `${key} must be reported missing`);
}
assert.equal(missing.ok, false);

const plaintextDb = validateProductionConfig({ ...required, DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app" });
assert.ok(plaintextDb.errors.some((line) => line.includes("DATABASE_URL must use sslmode")), "hosted databases must use TLS");
const verifiedDb = validateProductionConfig({ ...required, DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=verify-full" });
assert.deepEqual(verifiedDb.errors, [], "verify-full is accepted");
const localDb = validateProductionConfig({ ...required, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db", VERCEL: "1" });
assert.deepEqual(localDb.errors, [], "loopback development and CI stay plaintext");
const supabaseDirect = validateProductionConfig({ ...required, DATABASE_URL: "postgresql://user:pass@db.abcdef.supabase.com:5432/postgres?sslmode=require" });
assert.ok(supabaseDirect.warnings.some((line) => line.includes("transaction pooler")), "direct Supabase connections are flagged");

const insecure = validateProductionConfig({ ...required, APP_ORIGIN: "http://merchant.example.com", MARKETPLACE_API_URL: "http://market.example.com/api" });
assert.ok(insecure.errors.some((line) => line.includes("APP_ORIGIN must use HTTPS")));
assert.ok(insecure.errors.some((line) => line.includes("MARKETPLACE_API_URL must use HTTPS")));
assert.ok(insecure.errors.some((line) => line.includes("MARKETPLACE_API_URL must be a bare origin")));

const reused = validateProductionConfig({ ...required, MERCHANT_APP_TOKEN_ENCRYPTION_KEY: required.MERCHANT_APP_INTEGRATION_SECRET });
assert.ok(reused.errors.some((line) => line.includes("must differ")));

const short = validateProductionConfig({ ...required, MERCHANT_APP_INTEGRATION_SECRET: "short" });
assert.ok(short.errors.some((line) => line.includes("at least 32 characters")));

const halfRedis = validateProductionConfig({ ...required, UPSTASH_REDIS_REST_URL: "https://example.upstash.io" });
assert.ok(halfRedis.errors.some((line) => line.includes("Redis REST URL and token")));

const halfDispatch = validateProductionConfig({ ...required, COURIER_DISPATCH_SECRET: "c".repeat(40) });
assert.ok(halfDispatch.errors.some((line) => line.includes("COURIER_DISPATCH_URL and COURIER_DISPATCH_SECRET")));

const badHeader = validateProductionConfig({ ...required, TRUSTED_PROXY_IP_HEADER: "x fake header" });
assert.ok(badHeader.errors.some((line) => line.includes("TRUSTED_PROXY_IP_HEADER")));

const hosted = new URL(prepareDatabaseConnectionString("postgresql://user:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"));
assert.equal(hosted.searchParams.get("sslmode"), "require", "hosted connections get TLS even from a bare pooler URL");
assert.equal(hosted.searchParams.get("application_name"), "savour-partner");
const local = new URL(prepareDatabaseConnectionString("postgresql://postgres:postgres@127.0.0.1:5432/app_db"));
assert.equal(local.searchParams.get("sslmode"), null, "loopback development stays plaintext");
assert.equal(local.searchParams.get("application_name"), "savour-partner");
const explicit = new URL(prepareDatabaseConnectionString("postgresql://user:pass@db.example.com:5432/app?sslmode=verify-full"));
assert.equal(explicit.searchParams.get("sslmode"), "verify-full", "an explicit SSL mode is preserved");

console.log("PASS: production configuration preflight");
