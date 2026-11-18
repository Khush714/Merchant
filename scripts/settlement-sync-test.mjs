import "dotenv/config";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const database = process.env.DATABASE_URL;
if (!database || !["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) {
  throw new Error("The settlement sync smoke test requires a local DATABASE_URL.");
}
const run = randomUUID().replaceAll("-", "");
const appPort = 3101, mockPort = 4100;
const appBase = `http://127.0.0.1:${appPort}`;
const mockBase = `https://127.0.0.1:${mockPort}`;
const appOrigin = `http://127.0.0.1:${appPort}`;
const token = `merchant-token-${run}`;
const email = `settlement-${run}@example.test`;
const password = `T3st-${run}`;
const externalId = `pay_${run}`;
const marketplaceOrderId = `order_${run}`;
const secondExternalId = `pay_page2_${run}`;
const secondMarketplaceOrderId = `order_page2_${run}`;
const reference = `PAYOUT_${run}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function sql(statement) {
  return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function scalar(statement) {
  return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", statement], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function opensslCommand() {
  if (process.env.OPENSSL_PATH) return process.env.OPENSSL_PATH;
  if (process.platform !== "win32") return "openssl";
  return ["C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((candidate) => existsSync(candidate)) || "openssl";
}
function encryptedToken(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret, "utf8").digest(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
async function api(path, { cookie, method = "GET", body } = {}) {
  const response = await fetch(`${appBase}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: appOrigin, ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function waitFor(url, child) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    if (child?.exitCode !== null) throw new Error(`Server exited before becoming healthy (${child?.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Server did not become healthy.");
}

const original = {
  externalId,
  marketplaceOrderId,
  orderNumber: 2847,
  grossPaise: 70000,
  commissionPaise: 2000,
  refundPaise: 0,
  adjustmentPaise: -500,
  netPaise: 67500,
  currency: "INR",
  status: "paid",
  reference,
  paidAt: "2026-11-17T10:00:00Z",
  updatedAt: "2026-11-17T10:00:01Z",
};
let feed = { settlements: [original] };
let secondPage = null;
function mockRequest(request, response) {
  const url = new URL(request.url, mockBase);
  if (url.pathname !== "/api/integration/merchant/settlements" || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const page = Number(url.searchParams.get("page") || "1");
  const rows = page === 2 ? secondPage : feed.settlements;
  if (!rows) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "page not found" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, page, hasMore: page === 1 && Boolean(secondPage), settlements: rows }));
}
let server, mock, certDir;
let userId, businessId;
try {
  const secret = process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY || "ci-only-integration-encryption-key-0123456789";
  if (secret.trim().length < 32) throw new Error("Token encryption key is too short.");
  const integrationSecret = process.env.MERCHANT_APP_INTEGRATION_SECRET || "ci-only-integration-secret-0123456789";
  if (integrationSecret.trim().length < 32) throw new Error("Integration secret is too short.");
  certDir = mkdtempSync(join(tmpdir(), "savour-settlement-"));
  const keyPath = join(certDir, "key.pem"), certPath = join(certDir, "cert.pem");
  const generated = spawnSync(opensslCommand(), ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(`Could not create a local test certificate: ${generated.stderr}`);
  mock = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, mockRequest);
  await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));
  server = spawn(process.execPath, [join(process.cwd(), "node_modules/next/dist/bin/next"), "start", "-p", String(appPort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      DATABASE_URL: database,
      APP_ORIGIN: appOrigin,
      MARKETPLACE_API_URL: mockBase,
      MERCHANT_APP_TOKEN_ENCRYPTION_KEY: secret,
      MERCHANT_APP_INTEGRATION_SECRET: integrationSecret,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += chunk; });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });
  await waitFor(`${appBase}/api/health`, server);

  const registered = await api("/api/auth", { method: "POST", body: { action: "register", email, password } });
  assert.equal(registered.status, 201, serverLog);
  const cookie = registered.cookie;
  const draft = await api("/api/merchant/business", { cookie, method: "POST", body: { type: "restaurant" } });
  assert.equal(draft.status, 201, serverLog);
  businessId = draft.data.business.id;
  userId = scalar(`select id from users where email='${email}'`);
  assert.ok(userId);

  const restaurantId = 9_000_000 + Math.floor(Math.random() * 999_999);
  sql(`insert into business_marketplace_links (business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted) values ('${businessId}', ${restaurantId}, 'Settlement Test', 'settlement-test', '${encryptedToken(secret)}')`);

  const first = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual({ received: first.data.received, applied: first.data.applied, skipped: first.data.skipped }, { received: 1, applied: 1, skipped: 0 });
  assert.equal(scalar(`select amount || '|' || status || '|' || gross_amount || '|' || commission_amount || '|' || adjustment_amount || '|' || reference from settlements where external_id='${externalId}'`), `67500|paid|70000|2000|-500|${reference}`);

  const replay = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.applied, 0, "Replaying the same feed must not duplicate or rewrite a row.");
  assert.equal(scalar(`select count(*) from settlements where external_id='${externalId}'`), "1");

  feed = { settlements: [{ ...original, netPaise: 60000, grossPaise: 60000, commissionPaise: 0, adjustmentPaise: 0, updatedAt: "2026-11-16T10:00:01Z" }] };
  const stale = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(stale.status, 200);
  assert.equal(stale.data.applied, 0, "An older feed must not overwrite a newer settlement.");
  assert.equal(scalar(`select amount from settlements where external_id='${externalId}'`), "67500");

  feed = { settlements: [{ ...original, commissionPaise: 2500, netPaise: 67000, updatedAt: "2026-11-17T11:00:01Z" }] };
  const newer = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(newer.status, 200);
  assert.equal(newer.data.applied, 1, "A newer authoritative record must replace the mirrored amount.");
  assert.equal(scalar(`select amount from settlements where external_id='${externalId}'`), "67000");
  assert.ok(Number(scalar(`select count(*) from audit_logs where event='settlement.sync' and outcome='success' and business_id='${businessId}'`)) >= 4);

  secondPage = [{
    ...original,
    externalId: secondExternalId,
    marketplaceOrderId: secondMarketplaceOrderId,
    reference: `PAGE2_${run}`,
    paidAt: "2026-11-18T12:00:00Z",
    updatedAt: "2026-11-18T12:00:01Z",
  }];
  const paged = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(paged.status, 200, JSON.stringify(paged.data));
  assert.equal(paged.data.received, 2, "both authoritative pages must be read");
  assert.equal(paged.data.applied, 1, "only the new page-2 record should be inserted");
  assert.equal(scalar(`select reference from settlements where external_id='${secondExternalId}'`), `PAGE2_${run}`);
  assert.equal(paged.data.truncated, false);

  console.log("PASS: paginated, idempotent Marketplace settlement sync with stale-feed protection");
} finally {
  try {
    if (userId && businessId) {
      sql(`begin; delete from audit_logs where business_id='${businessId}' or actor_email_hash='${hash(email)}'; delete from business_marketplace_links where business_id='${businessId}'; delete from settlements where external_id in ('${externalId}','${secondExternalId}'); delete from sessions where user_id='${userId}'; delete from businesses where id='${businessId}'; delete from users where id='${userId}'; commit;`);
    }
  } catch (error) { console.error("Could not clean up settlement sync test records:", error.message); process.exitCode = 1; }
  if (server) server.kill();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
}
