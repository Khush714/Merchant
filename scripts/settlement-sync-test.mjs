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
const tokenB = `merchant-token-b-${run}`;
const email = `settlement-${run}@example.test`;
const emailB = `settlement-b-${run}@example.test`;
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
function encryptedToken(secret, value = token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret, "utf8").digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
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
let feedB = { settlements: [] };
let settlementRequests = 0;
let overviewRequests = 0;

const counts = { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, rejected: 0, cancelled: 0 };
const restaurant = {
  name: "Settlement Test", isActive: true, merchantHoursEnabled: false,
  merchantOpensAt: "09:00", merchantClosesAt: "22:00",
  merchantPickupEnabled: true, merchantDeliveryEnabled: true,
};
const validOverview = { ok: true, restaurant, overview: { counts, todaySales: 0, todayOrders: 0, completedToday: 0, latestNewOrderId: null } };

function mockRequest(request, response) {
  const url = new URL(request.url, mockBase);
  const auth = request.headers.authorization;
  const primary = auth === `Bearer ${token}`;
  const secondary = auth === `Bearer ${tokenB}`;
  const send = (body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (!primary && !secondary) return send({ ok: false, error: "not found" }, 404);

  if (url.pathname === "/api/integration/merchant/overview") {
    overviewRequests += 1;
    return send(validOverview);
  }
  if (url.pathname === "/api/integration/merchant/settlements") {
    settlementRequests += 1;
    const page = Number(url.searchParams.get("page") || "1");
    const rows = primary ? (page === 2 ? secondPage : feed.settlements) : (page === 2 ? null : feedB.settlements);
    if (!rows) return send({ ok: false, error: "page not found" }, 404);
    return send({ ok: true, page, hasMore: primary && page === 1 && Boolean(secondPage), settlements: rows });
  }
  return send({ ok: false, error: "not found" }, 404);
}

let server, mock, certDir;
let userId, businessId, userIdB, businessIdB;
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

  const registeredB = await api("/api/auth", { method: "POST", body: { action: "register", email: emailB, password } });
  assert.equal(registeredB.status, 201, serverLog);
  const cookieB = registeredB.cookie;
  const draftB = await api("/api/merchant/business", { cookie: cookieB, method: "POST", body: { type: "restaurant" } });
  assert.equal(draftB.status, 201, serverLog);
  businessIdB = draftB.data.business.id;
  userIdB = scalar(`select id from users where email='${emailB}'`);
  assert.ok(userIdB);

  const restaurantId = 9_000_000 + Math.floor(Math.random() * 999_999);
  sql(`insert into business_marketplace_links (business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted) values ('${businessId}', ${restaurantId}, 'Settlement Test', 'settlement-test', '${encryptedToken(secret)}')`);
  sql(`insert into business_marketplace_links (business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted) values ('${businessIdB}', ${restaurantId + 1}, 'Settlement Test B', 'settlement-test-b', '${encryptedToken(secret, tokenB)}')`);

  // Overview is a pure read: it must not fetch the settlement feed or write mirrored rows.
  const settlementRequestsBeforeOverview = settlementRequests;
  const overviewBefore = await api("/api/merchant/overview", { cookie });
  assert.equal(overviewBefore.status, 200, JSON.stringify(overviewBefore.data));
  assert.equal(settlementRequests, settlementRequestsBeforeOverview, "overview GET must not fetch the settlement feed");
  assert.equal(overviewBefore.data.overview.settlementSync.status, "idle");
  assert.match(overviewBefore.data.overview.settlementSync.message, /Refresh settlements/);
  assert.deepEqual(overviewBefore.data.overview.settlements, []);
  assert.equal(overviewRequests, 1);

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

  // Equal timestamps must be deterministic: the already-persisted row wins.
  feed = { settlements: [{ ...original, commissionPaise: 9999, netPaise: 59501, updatedAt: "2026-11-17T11:00:01Z" }] };
  const equal = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(equal.status, 200);
  assert.equal(equal.data.applied, 0, "An equal timestamp must not rewrite the persisted row.");
  assert.equal(scalar(`select amount from settlements where external_id='${externalId}'`), "67000");

  // Two pages: a genuinely new page-2 row plus a duplicate order id with an equal timestamp.
  const tieExternal = `pay_tie_${run}`, tieExternalB = `pay_tie_b_${run}`, tieOrder = `order_tie_${run}`;
  secondPage = [
    {
      ...original,
      externalId: secondExternalId,
      marketplaceOrderId: secondMarketplaceOrderId,
      reference: `PAGE2_${run}`,
      paidAt: "2026-11-18T12:00:00Z",
      updatedAt: "2026-11-18T12:00:01Z",
    },
    {
      ...original,
      externalId: tieExternalB,
      marketplaceOrderId: tieOrder,
      orderNumber: 3000,
      grossPaise: 20000,
      commissionPaise: 0,
      adjustmentPaise: 0,
      netPaise: 20000,
      reference: `TIE_B_${run}`,
      updatedAt: "2026-11-19T09:00:00Z",
    },
  ];
  feed = {
    settlements: [
      { ...original, commissionPaise: 2500, netPaise: 67000, updatedAt: "2026-11-17T11:00:01Z" },
      {
        ...original,
        externalId: tieExternal,
        marketplaceOrderId: tieOrder,
        orderNumber: 3000,
        grossPaise: 10000,
        commissionPaise: 0,
        adjustmentPaise: 0,
        netPaise: 10000,
        reference: `TIE_${run}`,
        updatedAt: "2026-11-19T09:00:00Z",
      },
    ],
  };
  const paged = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(paged.status, 200, JSON.stringify(paged.data));
  assert.equal(paged.data.received, 3, "both authoritative pages must be read and duplicate order ids merged");
  assert.equal(paged.data.applied, 2, "only the two new order ids should be inserted");
  assert.equal(scalar(`select reference from settlements where external_id='${secondExternalId}'`), `PAGE2_${run}`);
  assert.equal(scalar(`select amount from settlements where external_id='${tieExternal}'`), "10000");
  assert.equal(scalar(`select count(*) from settlements where external_id='${tieExternalB}'`), "0", "the duplicate order id from page two must be discarded");
  assert.equal(paged.data.truncated, false);
  secondPage = null;

  // Empty feeds are a successful no-op.
  feed = { settlements: [] };
  const empty = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  assert.deepEqual({ received: empty.data.received, applied: empty.data.applied }, { received: 0, applied: 0 });

  // A missing source timestamp is rejected before any write.
  feed = { settlements: [{ ...original, externalId: `pay_missing_${run}`, marketplaceOrderId: `order_missing_${run}`, reference: `MISSING_${run}`, updatedAt: null }] };
  const missing = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(missing.status, 502, JSON.stringify(missing.data));
  assert.equal(scalar(`select count(*) from settlements where external_id='pay_missing_${run}'`), "0");

  // 260 records across two feed pages cross the 250-row database batch boundary.
  const bulkRows = Array.from({ length: 260 }, (_, index) => ({
    ...original,
    externalId: `pay_bulk_${run}_${index}`,
    marketplaceOrderId: `order_bulk_${run}_${index}`,
    orderNumber: 400000 + index,
    reference: `BULK_${run}_${index}`,
    paidAt: "2026-11-19T10:00:00Z",
    updatedAt: "2026-11-19T10:01:00Z",
  }));
  feed = { settlements: bulkRows.slice(0, 200) };
  secondPage = bulkRows.slice(200);
  const bulk = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.deepEqual({ received: bulk.data.received, applied: bulk.data.applied }, { received: 260, applied: 260 });
  assert.equal(scalar(`select count(*) from settlements where external_id like 'pay_bulk_${run}_%'`), "260");
  assert.equal(scalar(`select count(*) from settlement_lines l join settlements s on s.id = l.settlement_id where s.external_id like 'pay_bulk_${run}_%'`), "260");
  secondPage = null;

  // A database failure in the second batch rolls the whole sync back; retry succeeds.
  const injectedExternalId = `pay_fail_${run}_255`;
  const failRows = bulkRows.map((row, index) => ({
    ...row,
    externalId: index === 255 ? injectedExternalId : `pay_fail_${run}_${index}`,
    marketplaceOrderId: `order_fail_${run}_${index}`,
    reference: `FAIL_${run}_${index}`,
    updatedAt: "2026-11-19T11:01:00Z",
  }));
  feed = { settlements: failRows.slice(0, 200) };
  secondPage = failRows.slice(200);
  const stampBeforeFailure = scalar(`select settlement_sync_attempted_at::text from business_marketplace_links where business_id='${businessId}'`);
  const functionName = `settlement_fail_${run}`;
  const triggerName = `settlement_fail_trigger_${run}`;
  sql(`create function ${functionName}() returns trigger language plpgsql as $$ begin if new.external_id = '${injectedExternalId}' then raise exception 'injected settlement batch failure'; end if; return new; end $$`);
  try {
    sql(`create trigger ${triggerName} before insert on settlements for each row execute function ${functionName}()`);
    const failed = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
    assert.notEqual(failed.status, 200, JSON.stringify(failed.data));
    assert.equal(scalar(`select count(*) from settlements where external_id like 'pay_fail_${run}_%'`), "0", "a failed batch must leave no partial rows");
    assert.equal(scalar(`select settlement_sync_attempted_at::text from business_marketplace_links where business_id='${businessId}'`), stampBeforeFailure, "a failed sync must not consume the retry window");
  } finally {
    sql(`drop trigger if exists ${triggerName} on settlements`);
    sql(`drop function if exists ${functionName}()`);
  }
  const retried = await api("/api/merchant/settlements/sync", { cookie, method: "POST" });
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal(retried.data.applied, 260, "retry after a partial failure must apply the full feed");
  assert.equal(scalar(`select count(*) from settlements where external_id like 'pay_fail_${run}_%'`), "260");
  secondPage = null;

  // A second outlet syncs independently with its own token and feed.
  feedB = { settlements: [{ ...original, externalId: `pay_b_${run}`, marketplaceOrderId: `order_b_${run}`, orderNumber: 5000, reference: `B_${run}`, updatedAt: "2026-11-19T12:00:00Z" }] };
  const businessARowsBefore = scalar(`select count(*) from settlements where business_id='${businessId}'`);
  const secondBusiness = await api("/api/merchant/settlements/sync", { cookie: cookieB, method: "POST" });
  assert.equal(secondBusiness.status, 200, JSON.stringify(secondBusiness.data));
  assert.equal(secondBusiness.data.applied, 1);
  assert.equal(scalar(`select count(*) from settlements where business_id='${businessId}'`), businessARowsBefore, "one outlet's sync must not write another outlet's rows");
  assert.equal(scalar(`select count(*) from settlements where business_id='${businessIdB}' and external_id='pay_b_${run}'`), "1");

  // Overview still reflects the persisted sync state without fetching the feed.
  const settlementRequestsBeforeFinalOverview = settlementRequests;
  const overviewAfter = await api("/api/merchant/overview", { cookie });
  assert.equal(overviewAfter.status, 200, JSON.stringify(overviewAfter.data));
  assert.equal(settlementRequests, settlementRequestsBeforeFinalOverview, "overview GET must not fetch the settlement feed after a sync");
  assert.equal(overviewAfter.data.overview.settlementSync.status, "synced");
  assert.ok(overviewAfter.data.overview.settlementSync.lastSyncedAt);

  console.log("PASS: read-only overview, batched/idempotent settlement sync, stale/equal/missing timestamp rules, partial-failure retry and business isolation");
} finally {
  try {
    if (userId || userIdB) {
      const ids = [userId, userIdB].filter(Boolean);
      const businesses = [businessId, businessIdB].filter(Boolean);
      const userList = ids.map((id) => `'${id}'`).join(",");
      const businessList = businesses.map((id) => `'${id}'`).join(",");
      sql(`begin;
        delete from audit_logs where business_id in (${businessList}) or actor_email_hash in ('${hash(email)}','${hash(emailB)}');
        delete from business_marketplace_links where business_id in (${businessList});
        delete from settlements where business_id in (${businessList});
        delete from sessions where user_id in (${userList});
        delete from businesses where id in (${businessList});
        delete from users where id in (${userList});
      commit;`);
    }
  } catch (error) { console.error("Could not clean up settlement sync test records:", error.message); process.exitCode = 1; }
  if (server) server.kill();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
}
