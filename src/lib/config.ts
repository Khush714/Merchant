/**
 * Pure production configuration checks shared by the startup preflight and tests.
 * No server-only imports here so the exact same rules can be asserted in CI.
 */

/** Mirrors `@/lib/urls` without pulling a path alias into the standalone test runner. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}
function isLoopbackUrl(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
}

/**
 * Normalise the private database URL for `pg`: hosted databases get explicit TLS
 * (the driver already maps `sslmode=require` to verified TLS), loopback stays
 * plaintext, and every connection is labelled in the pooler's logs.
 */
export function prepareDatabaseConnectionString(raw: string): string {
  const url = new URL(raw);
  if (!isLoopbackUrl(url) && !url.searchParams.has("sslmode") && !url.searchParams.has("ssl")) {
    url.searchParams.set("sslmode", "require");
  }
  url.searchParams.set("application_name", "savour-partner");
  return url.toString();
}

export type ConfigReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MIN_SECRET = 32;

function value(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function httpUrl(raw: string, label: string, production: boolean, errors: string[]): URL | null {
  if (!raw) {
    errors.push(`${label} is required.`);
    return null;
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { errors.push(`${label} must be a valid absolute URL.`); return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(`${label} must use HTTP or HTTPS.`);
    return null;
  }
  // Loopback stays allowed for local `next start` validation of the paired bridge.
  if (production && url.protocol !== "https:" && !isLoopbackUrl(url)) {
    errors.push(`${label} must use HTTPS in production.`);
  }
  if (url.username || url.password) errors.push(`${label} must not contain URL credentials.`);
  return url;
}

/**
 * Critical values fail fast; optional integrations are warnings unless they are
 * configured incompletely. This mirrors how the app already degrades at request time.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env, options: { production?: boolean } = {}): ConfigReport {
  const production = options.production ?? env.NODE_ENV === "production";
  const errors: string[] = [];
  const warnings: string[] = [];

  const databaseUrl = value(env, "DATABASE_URL");
  if (!databaseUrl) errors.push("DATABASE_URL is required.");
  else {
    try {
      const url = new URL(databaseUrl);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") errors.push("DATABASE_URL must be a PostgreSQL connection string.");
      if (!url.hostname) errors.push("DATABASE_URL must include a host.");
      // Supabase (like any hosted PostgreSQL) rejects plaintext connections. Node's
      // driver already upgrades `sslmode=require` to verified TLS by default.
      const sslmode = (url.searchParams.get("sslmode") ?? "").toLowerCase();
      if (production && !isLoopbackUrl(url) && !(sslmode === "require" || sslmode === "verify-full" || sslmode === "verify-ca")) {
        errors.push("DATABASE_URL must use sslmode=require or verify-full for a hosted PostgreSQL connection.");
      }
      if (/supabase\.com$/i.test(url.hostname) && (url.port === "5432" || !url.port)) {
        warnings.push("DATABASE_URL uses Supabase's direct connection; use the transaction pooler (port 6543) for serverless deployments.");
      }
    } catch { errors.push("DATABASE_URL must be a valid connection string."); }
  }

  const originRaw = value(env, "APP_ORIGIN");
  const origin = httpUrl(originRaw, "APP_ORIGIN", production, errors);
  if (origin && (origin.pathname !== "/" || origin.search || origin.hash)) errors.push("APP_ORIGIN must be a bare origin without a path.");

  const marketplaceRaw = value(env, "MARKETPLACE_API_URL");
  const marketplace = httpUrl(marketplaceRaw, "MARKETPLACE_API_URL", production, errors);
  if (marketplace && (marketplace.pathname !== "/" || marketplace.search || marketplace.hash)) errors.push("MARKETPLACE_API_URL must be a bare origin without a path.");

  const pairingSecret = value(env, "MERCHANT_APP_INTEGRATION_SECRET");
  if (pairingSecret.length < MIN_SECRET) errors.push("MERCHANT_APP_INTEGRATION_SECRET must contain at least 32 characters.");

  const encryptionKey = value(env, "MERCHANT_APP_TOKEN_ENCRYPTION_KEY");
  if (encryptionKey.length < MIN_SECRET) errors.push("MERCHANT_APP_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.");
  else if (encryptionKey === pairingSecret) errors.push("MERCHANT_APP_TOKEN_ENCRYPTION_KEY must differ from MERCHANT_APP_INTEGRATION_SECRET.");

  // Optional integrations must be complete pairs; a half-configured pair is a silent failure.
  const upstashUrl = value(env, "UPSTASH_REDIS_REST_URL") || value(env, "KV_REST_API_URL");
  const upstashToken = value(env, "UPSTASH_REDIS_REST_TOKEN") || value(env, "KV_REST_API_TOKEN");
  if (Boolean(upstashUrl) !== Boolean(upstashToken)) errors.push("Redis REST URL and token must be set together (UPSTASH_* or KV_*).");
  else if (!upstashUrl) warnings.push("Shared rate limiting is not configured; limits are per instance.");

  const dispatchUrl = value(env, "COURIER_DISPATCH_URL");
  const dispatchSecret = value(env, "COURIER_DISPATCH_SECRET");
  if (Boolean(dispatchUrl) !== Boolean(dispatchSecret)) errors.push("COURIER_DISPATCH_URL and COURIER_DISPATCH_SECRET must be set together.");
  else if (dispatchUrl) {
    httpUrl(dispatchUrl, "COURIER_DISPATCH_URL", production, errors);
    if (dispatchSecret.length < MIN_SECRET) errors.push("COURIER_DISPATCH_SECRET must contain at least 32 characters.");
  } else warnings.push("Outbound courier dispatch is not configured; handoff stays manual.");

  for (const key of ["COURIER_WEBHOOK_SECRET", "PAYMENT_WEBHOOK_SECRET"] as const) {
    const secret = value(env, key);
    if (secret && secret.length < MIN_SECRET) errors.push(`${key} must contain at least 32 characters.`);
    if (!secret) warnings.push(`${key} is not configured; signed webhook endpoints return 503.`);
  }

  const proxyHeader = value(env, "TRUSTED_PROXY_IP_HEADER");
  if (proxyHeader && !HEADER_NAME.test(proxyHeader)) errors.push("TRUSTED_PROXY_IP_HEADER must be a valid HTTP header name.");
  if (!proxyHeader && !env.VERCEL) warnings.push("No TRUSTED_PROXY_IP_HEADER is configured; clients share one rate-limit bucket.");

  const emailKey = value(env, "RESEND_API_KEY");
  const emailFrom = value(env, "EMAIL_FROM");
  if (Boolean(emailKey) !== Boolean(emailFrom)) warnings.push("RESEND_API_KEY and EMAIL_FROM should be set together.");
  if (!emailKey) warnings.push("Transactional email is not configured; account emails are skipped.");

  return { ok: errors.length === 0, errors, warnings };
}
