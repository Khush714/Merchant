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
  throw new Error("The paired flow smoke test requires a local DATABASE_URL.");
}
const run = randomUUID().replaceAll("-", "");
const appPort = 3102, mockPort = 4101;
const appBase = `http://127.0.0.1:${appPort}`;
const mockBase = `https://127.0.0.1:${mockPort}`;
const appOrigin = appBase;
const token = `paired-token-${run}`;
const email = `paired-${run}@example.test`;
const password = `T3st-${run}`;
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

const restaurant = {
  name: "Paired Kitchen", isActive: true, merchantHoursEnabled: false,
  merchantOpensAt: "09:00", merchantClosesAt: "22:00",
  merchantPickupEnabled: true, merchantDeliveryEnabled: true,
};
const counts = { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, rejected: 0, cancelled: 0 };
const validOverview = { ok: true, restaurant, overview: { counts, todaySales: 0, todayOrders: 0, completedToday: 0, latestNewOrderId: null, settlements: [] } };

let mode = "valid";
let failBusinessWrite = false;
let endlessSettlements = false;
let settlementRequests = 0;
function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function mockRequest(request, response) {
  const url = new URL(request.url, mockBase);
  if (request.headers.authorization !== `Bearer ${token}`) return send(response, 404, { ok: false, error: "not found" });

  if (url.pathname === "/api/integration/merchant/overview") {
    if (mode === "unauthorized") return send(response, 401, { ok: false, error: "Token revoked" });
    if (mode === "malformed") return send(response, 200, { ok: true, restaurant: { ...restaurant, name: 123 }, overview: validOverview.overview });
    return send(response, 200, validOverview);
  }
  if (url.pathname === "/api/integration/merchant/business" && request.method === "PATCH") {
    if (failBusinessWrite) return send(response, 500, { ok: false, error: "Marketplace is down" });
    return send(response, 200, { ok: true, restaurant });
  }
  if (url.pathname === "/api/integration/merchant/settlements") {
    settlementRequests++;
    const page = Number(url.searchParams.get("page") || "1");
    // The parser stops on an empty page even when hasMore is claimed, so each
    // page of the endless feed must carry a distinct, valid payout record.
    const settlements = endlessSettlements ? [{
      externalId: `pay_${run}_${page}`,
      marketplaceOrderId: `order_${run}_${page}`,
      orderNumber: page,
      grossPaise: 10_000,
      commissionPaise: 500,
      refundPaise: 0,
      adjustmentPaise: 0,
      netPaise: 9_500,
      currency: "INR",
      status: "paid",
      reference: `REF_${run}_${page}`,
      paidAt: "2026-11-18T10:00:00Z",
      updatedAt: "2026-11-18T10:00:00Z",
    }] : [];
    return send(response, 200, { ok: true, page, hasMore: endlessSettlements, settlements });
  }
  return send(response, 404, { ok: false, error: "not found" });
}

let server, mock, certDir;
let userId, businessId;
try {
  const secret = process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY || "ci-only-integration-encryption-key-0123456789";
  if (secret.trim().length < 32) throw new Error("Token encryption key is too short.");
  const integrationSecret = process.env.MERCHANT_APP_INTEGRATION_SECRET || "ci-only-integration-secret-0123456789";
  if (integrationSecret.trim().length < 32) throw new Error("Integration secret is too short.");

  certDir = mkdtempSync(join(tmpdir(), "savour-paired-"));
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
  sql(`insert into business_marketplace_links (business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted) values ('${businessId}', ${9_100_000 + Math.floor(Math.random() * 999_999)}, 'Paired Kitchen', 'paired-kitchen', '${encryptedToken(secret)}')`);

  // A valid paired overview takes the authoritative listing fields and converts cleanly.
  const valid = await api("/api/merchant/overview", { cookie });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));
  assert.equal(valid.data.business.name, restaurant.name);
  assert.equal(valid.data.business.approvalStatus, "approved");

  // A malformed upstream shape is a 502 with a machine-readable code, never empty local data.
  mode = "malformed";
  const malformed = await api("/api/merchant/overview", { cookie });
  assert.equal(malformed.status, 502, JSON.stringify(malformed.data));
  assert.equal(malformed.data.code, "MARKETPLACE_BAD_RESPONSE");

  // A revoked token produces a definitive link-invalid signal without wiping local data.
  mode = "unauthorized";
  const revoked = await api("/api/merchant/overview", { cookie });
  assert.equal(revoked.status, 401, JSON.stringify(revoked.data));
  assert.equal(revoked.data.code, "MARKETPLACE_LINK_INVALID");
  const linkState = await api("/api/merchant/marketplace-link", { cookie });
  assert.equal(linkState.status, 200, JSON.stringify(linkState.data));
  assert.equal(linkState.data.linked, true);
  assert.equal(linkState.data.valid, false);
  assert.equal(scalar(`select count(*) from business_marketplace_links where business_id='${businessId}'`), "1");
  mode = "valid";

  // A failed authoritative write leaves the local workspace unchanged.
  const before = scalar(`select is_open from businesses where id='${businessId}'`);
  failBusinessWrite = true;
  const failedWrite = await api("/api/merchant/business", { cookie, method: "PATCH", body: { action: "availability", isOpen: false } });
  assert.equal(failedWrite.status, 502, JSON.stringify(failedWrite.data));
  assert.equal(scalar(`select is_open from businesses where id='${businessId}'`), before);
  failBusinessWrite = false;
  const savedWrite = await api("/api/merchant/business", { cookie, method: "PATCH", body: { action: "availability", isOpen: false } });
  assert.equal(savedWrite.status, 200, JSON.stringify(savedWrite.data));
  assert.equal(scalar(`select is_open from businesses where id='${businessId}'`), "f");

  // An endless feed is capped at ten pages and reported as truncated, not silently dropped.
  endlessSettlements = true;
  settlementRequests = 0;
  const capped = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(capped.status, 200, JSON.stringify(capped.data));
  assert.equal(capped.data.truncated, true);
  assert.equal(settlementRequests, 10, "the page cap must bound upstream reads");
  assert.match(capped.data.message, /newest 2,000 payouts/);

  console.log("PASS: paired proxy validation, 401 invalidation, atomic writes and settlement cap");
} finally {
  try {
    if (userId && businessId) {
      sql(`begin; delete from audit_logs where business_id='${businessId}' or actor_email_hash='${hash(email)}'; delete from business_marketplace_links where business_id='${businessId}'; delete from settlements where business_id='${businessId}'; delete from sessions where user_id='${userId}'; delete from businesses where id='${businessId}'; delete from users where id='${userId}'; commit;`);
    }
  } catch (error) { console.error("Could not clean up paired flow test records:", error.message); process.exitCode = 1; }
  if (server) server.kill();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
}
