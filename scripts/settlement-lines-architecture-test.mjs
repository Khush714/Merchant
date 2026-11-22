import "dotenv/config";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySettlementLineValues, SETTLEMENT_LINE_VERSION } from "../src/lib/settlement-line-core.ts";

const database = process.env.DATABASE_URL;
if (!database || !["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) {
  throw new Error("The settlement-line architecture test requires a local DATABASE_URL.");
}
if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
  throw new Error("Run `npm run build` before the settlement-line architecture test.");
}

const run = randomUUID().replaceAll("-", "");
const appPort = 3102, mockPort = 4101;
const appBase = `http://127.0.0.1:${appPort}`;
const mockBase = `https://127.0.0.1:${mockPort}`;
const appOrigin = `http://127.0.0.1:${appPort}`;
const token = `architecture-token-${run}`;
const password = `T3st-${run}`;
const emails = [`architecture-a-${run}@example.test`, `architecture-b-${run}@example.test`];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = (value) => value ? `'${value}'` : "null";

function sql(statement) {
  return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
}
function scalar(statement) {
  return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-c", statement], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function jsonRow(statement) { return JSON.parse(scalar(statement)); }
function jsonArray(statement) { return JSON.parse(scalar(statement)); }
function opensslCommand() {
  if (process.env.OPENSSL_PATH) return process.env.OPENSSL_PATH;
  if (process.platform !== "win32") return "openssl";
  return ["C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"]
    .find((candidate) => existsSync(candidate)) || "openssl";
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
function lineFingerprint(businessId) {
  return scalar(`select count(*) || '|' || coalesce(md5(string_agg(
    l.id || ':' || l.xmin::text || ':' || l.net_paise || ':' || coalesce(l.rebuilt_at::text, ''),
    '|' order by l.id
  )), '') from settlement_lines l where l.business_id = '${businessId}'`);
}
function settlementLine(externalId, businessId) {
  return jsonRow(`select row_to_json(l) as j from settlement_lines l
    join settlements s on s.id = l.settlement_id
    where s.external_id = '${externalId}' and l.business_id = '${businessId}'`);
}
function insertSettlement({
  businessId, externalId, marketplaceOrderId, orderNumber = null,
  gross = 70000, commission = 2000, refund = 0, adjustment = 0,
  reference, paidAt = null, sourceUpdatedAt = null,
}) {
  sql(`insert into settlements
    (business_id, amount, external_id, marketplace_order_id, order_number, gross_amount,
     commission_amount, refund_amount, adjustment_amount, currency, status, reference, paid_at, source_updated_at)
    values ('${businessId}', ${gross - commission - refund + adjustment}, '${externalId}', '${marketplaceOrderId}',
      ${orderNumber === null ? "null" : orderNumber}, ${gross}, ${commission}, ${refund}, ${adjustment},
      'INR', 'paid', '${reference}', ${timestamp(paidAt)}, ${timestamp(sourceUpdatedAt)})`);
  return scalar(`select id from settlements where external_id = '${externalId}'`);
}
function legacyExpectation(externalId, businessId, orders, attempts, schedule = null) {
  const settlement = jsonRow(`select row_to_json(s) as j from settlements s where external_id = '${externalId}'`);
  return legacySettlementLineValues({
    businessId,
    settlements: [{
      id: settlement.id,
      orderNumber: settlement.order_number,
      grossAmount: settlement.gross_amount,
      commissionAmount: settlement.commission_amount,
      refundAmount: settlement.refund_amount,
      adjustmentAmount: settlement.adjustment_amount,
      paidAt: settlement.paid_at ? new Date(settlement.paid_at) : null,
      createdAt: new Date(settlement.created_at),
      sourceUpdatedAt: settlement.source_updated_at ? new Date(settlement.source_updated_at) : null,
    }],
    orders,
    attempts: attempts.map((attempt) => ({ ...attempt, createdAt: new Date(attempt.createdAt) })),
    schedule,
  })[0];
}
function assertLegacyEquivalence(actual, expected, label) {
  const fields = [
    ["gross_paise", "grossPaise"], ["commission_paise", "commissionPaise"],
    ["gateway_fee_paise", "gatewayFeePaise"], ["tax_paise", "taxPaise"],
    ["refund_paise", "refundPaise"], ["adjustment_paise", "adjustmentPaise"],
    ["net_paise", "netPaise"], ["expected_net_paise", "expectedNetPaise"],
  ];
  for (const [column, key] of fields) {
    assert.equal(actual[column], expected[key], `${label}: ${key}`);
  }
  assert.equal(actual.matches_authoritative, expected.matchesAuthoritative, `${label}: matchesAuthoritative`);
  assert.equal(actual.order_id ?? null, expected.orderId ?? null, `${label}: order linkage`);
  assert.equal(actual.payment_attempt_id ?? null, expected.paymentAttemptId ?? null, `${label}: attempt linkage`);
  assert.equal(new Date(actual.source_at).toISOString(), expected.sourceAt.toISOString(), `${label}: sourceAt`);
}

let feedMode = "ok";
let feedRows = [];
function mockRequest(request, response) {
  const url = new URL(request.url, mockBase);
  if (url.pathname !== "/api/integration/merchant/settlements" || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const page = Number(url.searchParams.get("page") || "1");
  const body = feedMode === "invalid"
    ? { ok: true, page, hasMore: false, settlements: [{ malformed: true }] }
    : { ok: true, page, hasMore: false, settlements: feedRows };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

let server, mock, certDir;
const accounts = {};
const runOrderNumber = 8_100_000 + Math.floor(Math.random() * 100_000);
const s1 = {
  externalId: `arch_s1_${run}`,
  marketplaceOrderId: `arch_mo1_${run}`,
  orderNumber: runOrderNumber,
  grossPaise: 70_000,
  commissionPaise: 2_000,
  refundPaise: 0,
  adjustmentPaise: -500,
  netPaise: 67_500,
  currency: "INR",
  status: "paid",
  reference: `ARCH_S1_${run}`,
  paidAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:01:00Z",
};

try {
  const secret = process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY || "ci-only-integration-encryption-key-0123456789";
  const integrationSecret = process.env.MERCHANT_APP_INTEGRATION_SECRET || "ci-only-integration-secret-0123456789";
  if (secret.trim().length < 32 || integrationSecret.trim().length < 32) throw new Error("Test secrets are too short.");
  certDir = mkdtempSync(join(tmpdir(), "savour-line-arch-"));
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

  async function makeAccount(email) {
    const registered = await api("/api/auth", { method: "POST", body: { action: "register", email, password } });
    assert.equal(registered.status, 201, serverLog);
    const draft = await api("/api/merchant/business", { cookie: registered.cookie, method: "POST", body: { type: "restaurant" } });
    assert.equal(draft.status, 201, serverLog);
    const businessId = draft.data.business.id;
    const userId = scalar(`select id from users where email = '${email}'`);
    assert.ok(userId);
    sql(`update businesses set approval_status = 'approved' where id = '${businessId}'`);
    return { cookie: registered.cookie, businessId, userId };
  }
  accounts.a = await makeAccount(emails[0]);
  accounts.b = await makeAccount(emails[1]);
  const a = accounts.a, b = accounts.b;

  const restaurantId = 9_100_000 + Math.floor(Math.random() * 999_999);
  sql(`insert into business_marketplace_links
    (business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted)
    values ('${a.businessId}', ${restaurantId}, 'Architecture Test', 'architecture-test', '${encryptedToken(secret)}')`);

  const orderId = scalar(`insert into orders
    (business_id, order_number, total, status, payment_status, idempotency_hash, request_hash)
    values ('${a.businessId}', ${runOrderNumber}, 70000, 'paid', 'paid',
      '${hash(`arch-order-${run}`)}', '${hash(`arch-order-request-${run}`)}') returning id`);
  const attemptsCreatedAt = ["2026-11-20T09:55:00Z", "2026-11-20T10:00:00Z"];
  const attemptIds = attemptsCreatedAt.map((createdAt, index) => scalar(`insert into payment_attempts
    (business_id, order_id, provider_reference, amount_paise, status, created_at)
    values ('${a.businessId}', '${orderId}', 'arch-attempt-${index}-${run}', 70000, 'succeeded', '${createdAt}') returning id`));
  const orders = [{ id: orderId, orderNumber: runOrderNumber }];
  const attempts = attemptIds.map((id, index) => ({ id, orderId, createdAt: attemptsCreatedAt[index] }));

  // Failed retry: an invalid feed must leave no derived line, then the valid replay creates it.
  feedMode = "invalid";
  const failed = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(failed.status, 502, serverLog);
  assert.equal(scalar(`select count(*) from settlement_lines where business_id = '${a.businessId}'`), "0");
  feedMode = "ok";
  feedRows = [s1];
  const first = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual({ received: first.data.received, applied: first.data.applied }, { received: 1, applied: 1 });
  assert.equal(first.data.lineCount, 1);
  assert.equal(scalar(`select count(*) from settlement_lines where business_id = '${a.businessId}'`), "1");

  let line = settlementLine(s1.externalId, a.businessId);
  assert.equal(line.line_version, SETTLEMENT_LINE_VERSION, "first-time processing stores the incremental version");
  assert.equal(line.payment_attempt_id, attemptIds[0], "legacy first-attempt linkage is preserved");
  assertLegacyEquivalence(line, legacyExpectation(s1.externalId, a.businessId, orders, attempts), "first-time line");

  // Duplicate and concurrent processing cannot create a second line.
  const replay = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.applied, 0, "an identical replay must not rewrite the authoritative settlement");
  const [concurrentA, concurrentB] = await Promise.all([
    api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" }),
    api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" }),
  ]);
  assert.equal(concurrentA.status, 200);
  assert.equal(concurrentB.status, 200);
  assert.equal(scalar(`select count(*) from settlement_lines where business_id = '${a.businessId}'`), "1");

  // Out-of-order updates must not roll money back.
  feedRows = [{ ...s1, grossPaise: 60_000, commissionPaise: 0, adjustmentPaise: 0, netPaise: 60_000, updatedAt: "2026-11-19T10:01:00Z" }];
  const stale = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(stale.status, 200);
  assert.equal(stale.data.applied, 0);
  assert.equal(scalar(`select amount from settlements where external_id = '${s1.externalId}'`), "67500");
  assert.equal(settlementLine(s1.externalId, a.businessId).net_paise, 67_500);

  // Incremental update from a newer authoritative version.
  feedRows = [{ ...s1, commissionPaise: 2_500, netPaise: 67_000, updatedAt: "2026-11-20T11:01:00Z" }];
  const newer = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(newer.status, 200);
  assert.equal(newer.data.applied, 1);
  line = settlementLine(s1.externalId, a.businessId);
  assert.equal(line.net_paise, 67_000);
  assert.equal(line.commission_paise, 2_500);
  assert.equal(new Date(line.source_updated_at).toISOString(), "2026-11-20T11:01:00.000Z");
  assertLegacyEquivalence(line, legacyExpectation(s1.externalId, a.businessId, orders, attempts), "incremental line");

  // Refunds/adjustments and a partial settlement with no matching local order.
  const s2 = {
    ...s1,
    externalId: `arch_s2_${run}`, marketplaceOrderId: `arch_mo2_${run}`,
    orderNumber: runOrderNumber + 1, grossPaise: 50_000, commissionPaise: 1_500, refundPaise: 2_000,
    adjustmentPaise: 0, netPaise: 46_500, reference: `ARCH_S2_${run}`,
    paidAt: "2026-11-21T09:00:00Z", updatedAt: "2026-11-21T10:01:00Z",
  };
  feedRows = [s2];
  const partial = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(partial.status, 200, JSON.stringify(partial.data));
  line = settlementLine(s2.externalId, a.businessId);
  assert.equal(line.order_id, null, "a settlement without a local order match stays unlinked");
  assert.equal(line.net_paise, 46_500);
  assert.equal(line.refund_paise, 2_000);
  assert.equal(settlementLine(s1.externalId, a.businessId).adjustment_paise, -500, "adjustments remain authoritative");
  assertLegacyEquivalence(line, legacyExpectation(s2.externalId, a.businessId, orders, attempts), "refund/partial line");

  // Ordinary reads must not create or refresh a derived line.
  const missingExternal = `arch_missing_${run}`;
  insertSettlement({
    businessId: a.businessId, externalId: missingExternal, marketplaceOrderId: `arch_mo_missing_${run}`,
    gross: 10_000, commission: 0, reference: `ARCH_MISSING_${run}`,
    paidAt: "2026-11-22T10:00:00Z", sourceUpdatedAt: "2026-11-22T10:01:00Z",
  });
  assert.equal(scalar(`select count(*) from settlement_lines l join settlements s on s.id = l.settlement_id where s.external_id = '${missingExternal}'`), "0");
  const fingerprintBeforeReads = lineFingerprint(a.businessId);
  const reads = await Promise.all([
    api("/api/merchant/settlement-lines?limit=200", { cookie: a.cookie }),
    api("/api/merchant/finance", { cookie: a.cookie }),
    api("/api/merchant/payouts", { cookie: a.cookie }),
    api("/api/merchant/reconciliation", { cookie: a.cookie }),
    api("/api/merchant/statements", { cookie: a.cookie }),
  ]);
  for (const read of reads) assert.equal(read.status, 200, serverLog);
  assert.equal(lineFingerprint(a.businessId), fingerprintBeforeReads, "read paths must not mutate settlement lines");
  assert.equal(scalar(`select count(*) from settlement_lines l join settlements s on s.id = l.settlement_id where s.external_id = '${missingExternal}'`), "0");

  // Historical compatibility: a legacy row and a missing row are repaired only by explicit sync.
  const legacyExternal = `arch_legacy_${run}`;
  const legacySettlementId = insertSettlement({
    businessId: a.businessId, externalId: legacyExternal, marketplaceOrderId: `arch_mo_legacy_${run}`,
    gross: 60_000, commission: 1_000, reference: `ARCH_LEGACY_${run}`,
    paidAt: "2026-11-19T10:00:00Z", sourceUpdatedAt: "2026-11-19T10:01:00Z",
  });
  sql(`insert into settlement_lines
    (business_id, settlement_id, gross_paise, commission_paise, gateway_fee_paise, tax_paise,
     refund_paise, adjustment_paise, net_paise, expected_net_paise, matches_authoritative,
     source, source_at, source_updated_at, line_version)
    values ('${a.businessId}', '${legacySettlementId}', 60000, 1000, 0, 0, 0, 0, 59000, 59000, true,
      'marketplace', '2026-11-19T10:00:00Z', '2026-11-19T10:01:00Z', 'legacy')`);
  assert.equal(settlementLine(legacyExternal, a.businessId).line_version, "legacy");
  feedRows = [s2];
  const repaired = await api("/api/merchant/settlements/sync", { cookie: a.cookie, method: "POST" });
  assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
  assert.ok(repaired.data.lineCount >= 2, "explicit sync repairs stale legacy and missing lines");
  line = settlementLine(legacyExternal, a.businessId);
  assert.equal(line.line_version, SETTLEMENT_LINE_VERSION);
  assert.equal(line.net_paise, 59_000, "historical money is unchanged by the upgrade");
  assert.equal(scalar(`select count(*) from settlement_lines l join settlements s on s.id = l.settlement_id where s.external_id = '${missingExternal}'`), "1");

  // Old statements without snapshots still read their stored line ids.
  const s1LineId = scalar(`select l.id from settlement_lines l join settlements s on s.id = l.settlement_id where s.external_id = '${s1.externalId}'`);
  const legacyStatementId = scalar(`insert into settlement_statements
    (business_id, number, period_from, period_to, gross_paise, commission_paise, gateway_fee_paise,
     tax_paise, refund_paise, adjustment_paise, net_paise, line_count, status, checksum, line_ids)
    values ('${a.businessId}', 'ST-LEGACY-${run}', '2026-11-01', '2026-11-30',
      70000, 2500, 0, 0, 0, -500, 67000, 1, 'closed', '${hash(`legacy-${run}`).slice(0, 24)}',
      '["${s1LineId}"]'::jsonb) returning id`);
  const oldDetail = await api(`/api/merchant/statements/${legacyStatementId}`, { cookie: a.cookie });
  assert.equal(oldDetail.status, 200, JSON.stringify(oldDetail.data));
  assert.deepEqual(oldDetail.data.statement.lines.map((row) => row.id), [s1LineId]);
  assert.equal(scalar(`select count(*) from settlement_statements where id = '${legacyStatementId}' and line_snapshot is null`), "1");

  // New statements freeze their lines; later line changes cannot rewrite them.
  const generatedStatement = await api("/api/merchant/statements", {
    cookie: a.cookie, method: "POST", body: { from: "2026-11-01", to: "2026-11-30" },
  });
  assert.equal(generatedStatement.status, 201, JSON.stringify(generatedStatement.data));
  assert.ok(generatedStatement.data.statement.lineCount >= 1);
  assert.equal(scalar(`select count(*) from settlement_statements where id = '${generatedStatement.data.statement.id}' and line_snapshot is not null`), "1");
  sql(`update settlement_lines set net_paise = net_paise + 1 where settlement_id = (select id from settlements where external_id = '${s1.externalId}')`);
  const frozenDetail = await api(`/api/merchant/statements/${generatedStatement.data.statement.id}`, { cookie: a.cookie });
  assert.equal(frozenDetail.status, 200);
  assert.equal(frozenDetail.data.statement.netPaise, generatedStatement.data.statement.netPaise, "statement totals are frozen");

  // Keyset pagination must expose every line instead of silently truncating payout choices.
  sql(`insert into settlements
    (business_id, amount, external_id, marketplace_order_id, currency, status, reference, source_updated_at)
    select '${a.businessId}', 10000, 'arch_page_${run}_' || g, 'arch_page_mo_${run}_' || g,
      'INR', 'paid', 'ARCH_PAGE_${run}_' || g, '2026-11-21T10:00:00Z'::timestamptz
    from generate_series(1, 205) g`);
  sql(`insert into settlement_lines
    (business_id, settlement_id, gross_paise, commission_paise, gateway_fee_paise, tax_paise,
     refund_paise, adjustment_paise, net_paise, expected_net_paise, matches_authoritative,
     source, source_at, source_updated_at, line_version)
    select l.business_id, l.id, 10000, 0, 0, 0, 0, 0, 10000, 10000, true,
      'marketplace', '2026-11-21T10:00:00Z'::timestamptz, l.source_updated_at, 'incremental-v1'
    from settlements l where l.external_id like 'arch_page_${run}_%'`);
  const firstPage = await api("/api/merchant/settlement-lines?limit=200", { cookie: a.cookie });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.data.lines.length, 200);
  assert.equal(firstPage.data.hasMore, true);
  assert.ok(firstPage.data.nextCursor);
  assert.ok(firstPage.data.count >= 205);
  const secondPage = await api(`/api/merchant/settlement-lines?limit=200&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`, { cookie: a.cookie });
  assert.equal(secondPage.status, 200);
  assert.ok(secondPage.data.lines.length > 0);
  const firstIds = new Set(firstPage.data.lines.map((line) => line.id));
  assert.ok(secondPage.data.lines.every((line) => !firstIds.has(line.id)), "keyset pages must not overlap");
  const badCursor = await api("/api/merchant/settlement-lines?cursor=not-a-cursor", { cookie: a.cookie });
  assert.equal(badCursor.status, 400);

  // Fee-schedule saves explicitly rebuild lines, and each business is isolated.
  const aFingerprint = lineFingerprint(a.businessId);
  const bExternal = `arch_b_${run}`;
  insertSettlement({
    businessId: b.businessId, externalId: bExternal, marketplaceOrderId: `arch_b_mo_${run}`,
    gross: 70_000, commission: 2_000, reference: `ARCH_B_${run}`,
    paidAt: "2026-11-20T10:00:00Z", sourceUpdatedAt: "2026-11-20T10:01:00Z",
  });
  const feeSave = await api("/api/merchant/fees", {
    cookie: b.cookie, method: "POST",
    body: { commissionBps: 0, platformFixedPaise: 0, gatewayBps: 200, gatewayFixedPaise: 0, gstBps: 1800 },
  });
  assert.equal(feeSave.status, 200, JSON.stringify(feeSave.data));
  assert.ok(feeSave.data.lineCount >= 1);
  const bLine = settlementLine(bExternal, b.businessId);
  assert.equal(bLine.line_version, SETTLEMENT_LINE_VERSION);
  assert.equal(bLine.gateway_fee_paise, 1_400);
  assert.equal(bLine.tax_paise, 612);
  assert.equal(bLine.net_paise, 65_988);
  assert.equal(bLine.expected_net_paise, 68_000);
  assert.equal(bLine.matches_authoritative, false, "a drifted local split is reported, not accepted");
  assert.ok(bLine.fee_schedule_id);
  assert.equal(lineFingerprint(a.businessId), aFingerprint, "one outlet's fee rebuild must not touch another outlet");
  const bLines = await api("/api/merchant/settlement-lines", { cookie: b.cookie });
  assert.equal(bLines.status, 200);
  assert.ok(bLines.data.lines.every((line) => ![s1.externalId, s2.externalId, missingExternal].includes(
    scalar(`select external_id from settlements where id = '${line.settlementId}'`))), "business ledger isolation");

  console.log("PASS: settlement-line processing, read-only paths, historical compatibility and equivalence");
} finally {
  try {
    if (accounts.a && accounts.b) {
      const ids = [accounts.a.businessId, accounts.b.businessId];
      const hashes = emails.map((email) => hash(email));
      sql(`begin;
        delete from audit_logs where business_id in ('${ids[0]}','${ids[1]}') or actor_email_hash in ('${hashes[0]}','${hashes[1]}');
        delete from settlement_statements where business_id in ('${ids[0]}','${ids[1]}');
        delete from settlement_lines where business_id in ('${ids[0]}','${ids[1]}');
        delete from settlements where business_id in ('${ids[0]}','${ids[1]}');
        delete from payment_attempts where business_id in ('${ids[0]}','${ids[1]}');
        delete from orders where business_id in ('${ids[0]}','${ids[1]}');
        delete from fee_schedules where business_id in ('${ids[0]}','${ids[1]}');
        delete from business_marketplace_links where business_id in ('${ids[0]}','${ids[1]}');
        delete from sessions where user_id in ('${accounts.a.userId}','${accounts.b.userId}');
        delete from businesses where id in ('${ids[0]}','${ids[1]}');
        delete from users where id in ('${accounts.a.userId}','${accounts.b.userId}');
      commit;`);
    }
  } catch (error) {
    console.error("Could not clean up settlement-line architecture test records:", error.message);
    process.exitCode = 1;
  }
  if (server) server.kill();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
}
