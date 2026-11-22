import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const database = process.env.DATABASE_URL;
if (!database || !["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) throw new Error("This disposable smoke test requires a local DATABASE_URL.");
const run = randomUUID().replaceAll("-", "");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const emails = [`restaurant-${run}@example.test`, `vendor-${run}@example.test`, `reassign-${run}@example.test`];
const missingEmail = `missing-${run}@example.test`;
const emailHashes = [...emails, missingEmail].map((email) => `'${hash(email)}'`).join(",");
const owners = `select id from users where email in (${emails.map((email) => `'${email}'`).join(",")})`;
// Outlets created during the run are not in the startup snapshot, so track them for cleanup.
const extraOutletIds = [];
const shopIds = () => `select id from businesses where owner_id in (${owners})${extraOutletIds.length ? ` or id in (${extraOutletIds.map((id) => `'${id}'`).join(",")})` : ""}`;
const testOrders = () => `select id from orders where business_id in (${shopIds()})`;
function sql(statement) { execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], { stdio: "pipe" }); }
function scalar(statement) { return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", statement], { encoding: "utf8" }).trim(); }
function accountToken(value, email, purpose, expiry = "now() + interval '1 hour'") {
  sql(`begin; delete from account_tokens where user_id=(select id from users where email='${email}') and purpose='${purpose}'; insert into account_tokens (token_hash, user_id, purpose, expires_at) values ('${hash(value)}', (select id from users where email='${email}'), '${purpose}', ${expiry}); commit;`);
}
async function request(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const send = () => fetch(`${base}${path}`, { method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  // A pooled socket can be recycled by the local server while the rate-limit window is idle.
  // Retry only that transport error; application responses are still asserted verbatim.
  const sendFresh = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await send(); } catch (error) {
        const reset = error instanceof TypeError && error.cause?.code === "ECONNRESET";
        if (!reset || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  let response = await sendFresh();
  // The auth bucket allows a fixed number of requests per IP per minute. A repeated run started
  // shortly after a previous one can trip it; wait for the window once instead of failing the run.
  if (response.status === 429) {
    console.warn("Rate limited; waiting 61s for the per-IP window to reset, then retrying once.");
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    response = await sendFresh();
  }
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
function signedProviderEvent(path, secret, body, { timestamp = Math.floor(Date.now() / 1000), signingSecret = secret } = {}) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", signingSecret).update(`${timestamp}.${raw}`).digest("hex");
  return request(path, { method: "POST", headers: { "x-savour-signature": `t=${timestamp},v1=${signature}` }, body });
}
async function adminOwnerRequest(body) {
  return request("/api/admin/owner", { method: "POST", body, headers: { authorization: `Bearer ${process.env.MARKETPLACE_ADMIN_TOKEN ?? ""}` } });
}
async function rawRequest(path, { method = "POST", cookie, body, contentType } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(contentType ? { "content-type": contentType } : {}) }, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function account(email, type) {
  const registered = await request("/api/auth", { method: "POST", body: { action: "register", email, password: `T3st-${run}` } });
  assert.equal(registered.status, 201); assert.ok(registered.cookie);
  assert.equal(registered.data.verificationRequired, false); assert.equal(registered.data.user.emailVerified, false);
  const draft = await request("/api/merchant/business", { method: "POST", cookie: registered.cookie, body: { type } });
  assert.equal(draft.status, 201); assert.equal(draft.data.business.type, type); assert.equal(draft.data.business.approvalStatus, "draft");
  await request("/api/merchant/business", { method: "PATCH", cookie: registered.cookie, body: { action: "details", name: `Draft ${type}`, ownerName: "", phone: "", address: "", submit: false } });
  const resumed = await request("/api/auth", { cookie: registered.cookie }); assert.equal(resumed.data.business.approvalStatus, "draft"); assert.equal(resumed.data.business.name, `Draft ${type}`); assert.equal(resumed.data.business.type, type);
  const submitted = await request("/api/merchant/business", { method: "PATCH", cookie: registered.cookie, body: { action: "details", name: `Smoke ${type}`, ownerName: "Test Owner", phone: "9999999999", address: "Test address", category: "Test", submit: true } });
  assert.equal(submitted.data.business.approvalStatus, "pending");
  const blocked = await request("/api/merchant/business", { method: "PATCH", cookie: registered.cookie, body: { action: "availability", isOpen: true } });
  assert.equal(blocked.status, 403);
  const session = await request("/api/auth", { cookie: registered.cookie });
  assert.equal(session.data.business.type, type);
  return { cookie: registered.cookie, business: submitted.data.business };
}
async function transition(cookie, id, expectedStatus, nextStatus, extra = {}) { return request("/api/merchant/orders", { method: "PATCH", cookie, body: { id, expectedStatus, nextStatus, ...extra } }); }
try {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.equal(health.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(health.headers.get("strict-transport-security") ?? "", /max-age=/);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  const scriptSrc = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src ")) ?? "";
  const nonce = (value) => value.match(/'nonce-([^']+)'/)?.[1];
  assert.match(scriptSrc, /'nonce-[^']+'/);
  assert.match(scriptSrc, /'strict-dynamic'/);
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  const nonceValue = nonce(csp);
  assert.ok(nonceValue);
  assert.match(await page.text(), new RegExp(`nonce="${nonceValue}"`));
  const secondPage = await fetch(`${base}/`);
  assert.notEqual(nonce(secondPage.headers.get("content-security-policy") ?? ""), nonceValue);
  const missing = await fetch(`${base}/this-route-does-not-exist`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
  const publicAuth = await request("/api/auth");
  assert.equal(publicAuth.status, 200); assert.equal(publicAuth.data.user, null); assert.equal(publicAuth.data.verificationRequired, false);
  const unauth = await request("/api/merchant/orders"); assert.equal(unauth.status, 401);
  assert.equal((await request("/api/admin/approval", { method: "POST", body: { businessId: randomUUID(), status: "approved" } })).status, 403);
  assert.equal((await request("/api/admin/owner", { method: "POST", body: { businessId: randomUUID(), email: "nobody@example.test" }, headers: { authorization: "Bearer wrong-token" } })).status, 403);
  assert.ok(Number(scalar(`select count(*) from audit_logs where event='admin.approval' and outcome='denied' and detail->>'reason'='invalid_token' and created_at > now() - interval '2 minutes'`)) >= 1);
  assert.equal((await rawRequest("/api/marketplace", { body: "{not json", contentType: "application/json" })).status, 400);
  assert.equal((await rawRequest("/api/marketplace", { body: "businessId=1", contentType: "text/plain" })).status, 415);
  assert.equal((await rawRequest("/api/marketplace", { body: JSON.stringify({ padding: "x".repeat(140 * 1024) }), contentType: "application/json" })).status, 413);
  assert.equal((await rawRequest("/api/marketplace", { body: "", contentType: "application/json" })).status, 400);
  const restaurant = await account(emails[0], "restaurant"), vendor = await account(emails[1], "vendor");
  const reassignTarget = await request("/api/auth", { method: "POST", body: { action: "register", email: emails[2], password: `T3st-${run}` } });
  assert.equal(reassignTarget.status, 201); assert.ok(reassignTarget.cookie); assert.equal(reassignTarget.data.business, null);
  for (const email of emails) {
    assert.equal(scalar(`select count(*) from audit_logs where event='auth.register' and outcome='success' and actor_email_hash='${hash(email)}' and actor_user_id=(select id from users where email='${email}')`), "1");
  }
  assert.equal(scalar(`select count(*) from audit_logs where request_id is null or ip_hash is null or outcome not in ('success','failure','denied')`), "0");
  // Verification links are hashed at rest, expire and can only be redeemed once.
  const verifyToken = `v${run}`, vendorVerifyToken = `vv${run}`, expiredToken = `e${run}`;
  accountToken(verifyToken, emails[0], "verify_email");
  assert.equal(scalar(`select count(*) from account_tokens where token_hash='${hash(verifyToken)}' and purpose='verify_email' and consumed_at is null`), "1");
  const verified = await request("/api/auth", { method: "POST", body: { action: "verify-email", token: verifyToken } });
  assert.equal(verified.status, 200); assert.equal(verified.data.emailVerified, true);
  assert.equal(scalar(`select email_verified_at is not null from users where email='${emails[0]}'`), "t");
  assert.equal(scalar(`select consumed_at is not null from account_tokens where token_hash='${hash(verifyToken)}'`), "t");
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "verify-email", token: verifyToken } })).status, 400);
  assert.equal((await request("/api/auth", { cookie: restaurant.cookie })).data.user.emailVerified, true);
  accountToken(expiredToken, emails[0], "verify_email", "now() - interval '1 minute'");
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "verify-email", token: expiredToken } })).status, 400);
  // Unknown addresses get the same answer as known ones and never receive a token.
  const forgot = await request("/api/auth", { method: "POST", body: { action: "forgot-password", email: emails[1] } });
  assert.equal(forgot.status, 200);
  assert.equal(scalar(`select count(*) from account_tokens where user_id=(select id from users where email='${emails[1]}') and purpose='reset_password' and consumed_at is null`), "1");
  const forgotMissing = await request("/api/auth", { method: "POST", body: { action: "forgot-password", email: missingEmail } });
  assert.equal(forgotMissing.status, 200); assert.deepEqual(forgotMissing.data, forgot.data);
  // Resending replaces any outstanding verification link; verified accounts get no new one.
  const resent = await request("/api/auth", { method: "POST", cookie: vendor.cookie, body: { action: "resend-verification" } });
  assert.equal(resent.status, 200);
  assert.equal(scalar(`select count(*) from account_tokens where user_id=(select id from users where email='${emails[1]}') and purpose='verify_email' and consumed_at is null`), "1");
  accountToken(vendorVerifyToken, emails[1], "verify_email");
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "verify-email", token: vendorVerifyToken } })).status, 200);
  assert.equal(scalar(`select count(*) from account_tokens where user_id=(select id from users where email='${emails[1]}') and purpose='verify_email' and consumed_at is null`), "0");
  const alreadyVerified = await request("/api/auth", { method: "POST", cookie: vendor.cookie, body: { action: "resend-verification" } });
  assert.equal(alreadyVerified.data.sent, false);
  assert.equal(scalar(`select count(*) from account_tokens where user_id=(select id from users where email='${emails[1]}') and purpose='verify_email' and consumed_at is null`), "0");
  let marketplace = await request("/api/marketplace"); assert.ok(!marketplace.data.businesses.some((b) => [restaurant.business.id, vendor.business.id].includes(b.id)));
  // Simulate the trusted review system in a disposable local database.
  sql(`update businesses set approval_status='approved' where id in (${shopIds()})`);
  for (const account of [restaurant, vendor]) { const opened = await request("/api/merchant/business", { method: "PATCH", cookie: account.cookie, body: { action: "availability", isOpen: true } }); assert.equal(opened.status, 200); }

  // Compliance is advisory: owner-write, manager-read, and never a gate on orders.
  assert.equal((await request("/api/merchant/compliance")).status, 401);
  const complianceInitial = await request("/api/merchant/compliance", { cookie: restaurant.cookie });
  assert.equal(complianceInitial.status, 200);
  assert.equal(complianceInitial.data.compliance.agreement.accepted, false);
  assert.ok(Array.isArray(complianceInitial.data.compliance.advisories));
  const complianceSaved = await request("/api/merchant/compliance", { method: "PATCH", cookie: restaurant.cookie, body: { legalName: "Smoke Foods", gstin: "27AAPFU0939F1ZV", taxRegime: "regular", taxInclusive: true, defaultTaxRateBps: 500 } });
  assert.equal(complianceSaved.status, 200);
  assert.equal(complianceSaved.data.compliance.legalName, "Smoke Foods");
  assert.equal((await request("/api/merchant/compliance", { method: "PATCH", cookie: restaurant.cookie, body: { gstin: "BAD" } })).status, 400);
  const agreementCurrent = await request("/api/merchant/compliance/agreement", { cookie: restaurant.cookie });
  const agreementAccepted = await request("/api/merchant/compliance/agreement", { method: "POST", cookie: restaurant.cookie, body: { version: agreementCurrent.data.agreement.version, contentHash: agreementCurrent.data.agreement.contentHash, accepted: true } });
  assert.equal(agreementAccepted.status, 200);
  assert.equal(agreementAccepted.data.agreement.accepted, true);
  const payoutLocal = await request("/api/merchant/compliance/payout", { cookie: restaurant.cookie });
  assert.equal(payoutLocal.status, 200);
  assert.equal(payoutLocal.data.payout.available, false);
  assert.equal((await request("/api/merchant/compliance/payout", { method: "POST", cookie: restaurant.cookie, body: { method: "upi", upiId: "smoke@bank" } })).status, 409);
  marketplace = await request("/api/marketplace"); assert.ok(marketplace.data.businesses.some((b) => b.id === restaurant.business.id)); assert.ok(marketplace.data.businesses.some((b) => b.id === vendor.business.id));
  const itemBody = { name: "Test meal", description: "", price: 25000, category: "Mains", imageUrl: "", dietary: "veg" };
  const disposableItem = await request("/api/merchant/menu", { method: "POST", cookie: restaurant.cookie, body: { ...itemBody, name: "Archive test" } });
  assert.equal((await request("/api/merchant/menu", { method: "DELETE", cookie: restaurant.cookie, body: { id: disposableItem.data.item.id } })).status, 200);
  const rItem = await request("/api/merchant/menu", { method: "POST", cookie: restaurant.cookie, body: itemBody });
  const vItem = await request("/api/merchant/menu", { method: "POST", cookie: vendor.cookie, body: { ...itemBody, name: "Test chai", price: 5000 } });
  assert.equal(rItem.status, 201); assert.equal(vItem.status, 201);
  const forbiddenMenu = await request("/api/merchant/menu", { method: "PATCH", cookie: restaurant.cookie, body: { action: "availability", id: vItem.data.item.id, available: false } }); assert.equal(forbiddenMenu.status, 404);
  const payload = { businessId: restaurant.business.id, idempotencyKey: randomUUID(), customerName: "Test customer", customerNote: "No spice", fulfilment: "pickup", items: [{ id: rItem.data.item.id, quantity: 2 }] };
  const placed = await request("/api/marketplace", { method: "POST", body: payload }); assert.equal(placed.status, 201); assert.equal(placed.data.order.total, 50000);
  const duplicate = await request("/api/marketplace", { method: "POST", body: payload }); assert.equal(duplicate.data.order.id, placed.data.order.id);
  const mismatch = await request("/api/marketplace", { method: "POST", body: { ...payload, customerNote: "different" } }); assert.equal(mismatch.status, 409);
  const vPayload = { businessId: vendor.business.id, idempotencyKey: randomUUID(), customerName: "Vendor customer", fulfilment: "pickup", items: [{ id: vItem.data.item.id, quantity: 1 }] };
  const vOrder = await request("/api/marketplace", { method: "POST", body: vPayload }); assert.equal(vOrder.status, 201);
  const list = await request("/api/merchant/orders?status=all", { cookie: restaurant.cookie }); assert.ok(list.data.orders.some((o) => o.id === placed.data.order.id)); assert.ok(!list.data.orders.some((o) => o.id === vOrder.data.order.id));
  const cross = await transition(restaurant.cookie, vOrder.data.order.id, "new", "accepted", { prepMinutes: 20 }); assert.equal(cross.status, 404);
  const competing = await Promise.all([transition(restaurant.cookie, placed.data.order.id, "new", "accepted", { prepMinutes: 20 }), transition(restaurant.cookie, placed.data.order.id, "new", "accepted", { prepMinutes: 20 })]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await transition(restaurant.cookie, placed.data.order.id, "new", "accepted", { prepMinutes: 20 })).status, 409);
  assert.equal((await transition(restaurant.cookie, placed.data.order.id, "accepted", "preparing")).status, 200);
  assert.equal((await transition(restaurant.cookie, placed.data.order.id, "preparing", "ready")).status, 200);
  const tracking = await request(`/api/marketplace?orderId=${placed.data.order.id}&token=${payload.idempotencyKey}`); assert.equal(tracking.data.order.status, "ready");
  assert.equal((await request(`/api/marketplace?orderId=${placed.data.order.id}&token=${randomUUID()}`)).status, 404);
  const earlyFeedback = await request("/api/marketplace/feedback", { method: "POST", body: { orderId: placed.data.order.id, token: payload.idempotencyKey, rating: 5 } });
  assert.equal(earlyFeedback.status, 409);
  assert.equal((await transition(restaurant.cookie, placed.data.order.id, "ready", "completed")).status, 200);

  const proforma = await request("/api/merchant/compliance/invoices", { method: "POST", cookie: restaurant.cookie, body: { action: "proforma", orderId: placed.data.order.id } });
  assert.equal(proforma.status, 201);
  assert.equal(proforma.data.invoice.source, "proforma");
  const invoicePdf = await fetch(`${base}/api/merchant/compliance/invoices/${proforma.data.invoice.id}/pdf`, { headers: { cookie: restaurant.cookie } });
  assert.equal(invoicePdf.status, 200);
  assert.match(invoicePdf.headers.get("content-type") ?? "", /application\/pdf/);
  assert.match(await invoicePdf.text(), /PRO FORMA INVOICE/);
  const wrongTokenFeedback = await request("/api/marketplace/feedback", { method: "POST", body: { orderId: placed.data.order.id, token: randomUUID(), rating: 5 } });
  assert.equal(wrongTokenFeedback.status, 404);
  const reviewed = await request("/api/marketplace/feedback", { method: "POST", body: { orderId: placed.data.order.id, token: payload.idempotencyKey, rating: 2, review: "Cold food" } });
  assert.equal(reviewed.status, 200); assert.equal(reviewed.data.feedback.rating, 2); assert.equal(reviewed.data.alreadySubmitted, false);
  const duplicateReview = await request("/api/marketplace/feedback", { method: "POST", body: { orderId: placed.data.order.id, token: payload.idempotencyKey, rating: 5 } });
  assert.equal(duplicateReview.status, 200); assert.equal(duplicateReview.data.alreadySubmitted, true); assert.equal(duplicateReview.data.feedback.rating, 2);
  const feedbackTracking = await request(`/api/marketplace?orderId=${placed.data.order.id}&token=${payload.idempotencyKey}`);
  assert.equal(feedbackTracking.data.order.feedback.rating, 2); assert.equal(feedbackTracking.data.order.feedback.merchantResponse, "");
  const feedbackList = await request("/api/merchant/orders?status=feedback", { cookie: restaurant.cookie });
  assert.ok(feedbackList.data.orders.some((order) => order.id === placed.data.order.id && order.rating === 2));
  const pendingFeedback = await request("/api/merchant/overview", { cookie: restaurant.cookie });
  assert.equal(pendingFeedback.data.overview.feedback.averageRating, 2); assert.equal(pendingFeedback.data.overview.feedback.reviewCount, 1);
  assert.equal(pendingFeedback.data.overview.feedback.badOrders, 1); assert.equal(pendingFeedback.data.overview.feedback.pendingReplies, 1);
  const reply = await request("/api/merchant/feedback", { method: "PATCH", cookie: restaurant.cookie, body: { id: placed.data.order.id, response: "Sorry about that — we'll keep it hotter." } });
  assert.equal(reply.status, 200); assert.equal(reply.data.proxied, false); assert.match(reply.data.feedback.merchantResponse, /keep it hotter/);
  const secondReply = await request("/api/merchant/feedback", { method: "PATCH", cookie: restaurant.cookie, body: { id: placed.data.order.id, response: "Another reply" } });
  assert.equal(secondReply.status, 409);
  const repliedTracking = await request(`/api/marketplace?orderId=${placed.data.order.id}&token=${payload.idempotencyKey}`);
  assert.match(repliedTracking.data.order.feedback.merchantResponse, /keep it hotter/);
  assert.equal(scalar(`select count(*) from order_events where order_id='${placed.data.order.id}' and reason='Customer feedback submitted'`), "1");
  assert.equal(scalar(`select count(*) from order_events where order_id='${placed.data.order.id}' and reason='Merchant replied to customer feedback'`), "1");
  // Offers: owner-scoped CRUD, public visibility, server-side discounts, limits and idempotency.
  const offerBody = (code, extra = {}) => ({ code, title: `${code} title`, description: "", discountType: "percent", value: 10, minOrder: 0, maxDiscount: null, startsAt: null, endsAt: null, usageLimit: null, active: true, ...extra });
  const save10 = await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("SAVE10") });
  assert.equal(save10.status, 201); assert.equal(save10.data.offer.code, "SAVE10");
  assert.equal((await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("SAVE10") })).status, 409);
  assert.equal((await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("BAD!", { value: 200 }) })).status, 400);
  const flatOffer = await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("FLAT50", { discountType: "flat", value: 5000 }) }); assert.equal(flatOffer.status, 201);
  const minOffer = await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("MIN500", { minOrder: 50000 }) }); assert.equal(minOffer.status, 201);
  const futureOffer = await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("FUTURE", { startsAt: new Date(Date.now() + 86400000).toISOString() }) }); assert.equal(futureOffer.status, 201);
  const limitOffer = await request("/api/merchant/offers", { method: "POST", cookie: restaurant.cookie, body: offerBody("LIMIT1", { usageLimit: 1 }) }); assert.equal(limitOffer.status, 201);
  assert.equal((await request("/api/merchant/offers", { cookie: restaurant.cookie })).data.offers.length, 5);
  assert.equal((await request("/api/merchant/offers", { cookie: vendor.cookie })).data.offers.length, 0);
  const publicWithOffers = await request(`/api/marketplace?businessId=${restaurant.business.id}`);
  assert.ok(publicWithOffers.data.offers.some((offer) => offer.code === "SAVE10"));
  assert.ok(!publicWithOffers.data.offers.some((offer) => offer.code === "FUTURE"));
  assert.ok(!("usageLimit" in publicWithOffers.data.offers[0]));
  const offerPayload = { businessId: restaurant.business.id, idempotencyKey: randomUUID(), customerName: "Offer customer", fulfilment: "pickup", items: [{ id: rItem.data.item.id, quantity: 1 }], offerCode: "SAVE10" };
  const discounted = await request("/api/marketplace", { method: "POST", body: offerPayload });
  assert.equal(discounted.status, 201); assert.equal(discounted.data.order.total, 22500); assert.equal(discounted.data.order.discount, 2500); assert.equal(discounted.data.order.offerCode, "SAVE10");
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, offerCode: "FLAT50" } })).status, 409);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "NOPE" } })).status, 404);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "MIN500" } })).status, 409);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "FUTURE" } })).status, 409);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "LIMIT1" } })).status, 201);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "LIMIT1" } })).status, 409);
  const paused = await request("/api/merchant/offers", { method: "PATCH", cookie: restaurant.cookie, body: { id: save10.data.offer.id, action: "toggle" } }); assert.equal(paused.status, 200); assert.equal(paused.data.offer.active, false);
  assert.ok(!(await request(`/api/marketplace?businessId=${restaurant.business.id}`)).data.offers.some((offer) => offer.code === "SAVE10"));
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...offerPayload, idempotencyKey: randomUUID(), offerCode: "SAVE10" } })).status, 404);
  assert.equal((await request("/api/merchant/offers", { method: "PATCH", cookie: restaurant.cookie, body: { id: save10.data.offer.id, action: "toggle" } })).status, 200);
  assert.equal((await request("/api/merchant/offers", { method: "DELETE", cookie: restaurant.cookie, body: { id: minOffer.data.offer.id } })).status, 200);
  const archivedOffer = (await request("/api/merchant/offers", { cookie: restaurant.cookie })).data.offers.find((offer) => offer.code === "MIN500");
  assert.equal(archivedOffer.archived, true); assert.equal(archivedOffer.active, false);
  const offerMetrics = (await request("/api/merchant/offers", { cookie: restaurant.cookie })).data.offers.find((offer) => offer.code === "SAVE10");
  assert.equal(offerMetrics.redemptions, 1); assert.equal(offerMetrics.discountGiven, 2500);
  assert.equal(scalar(`select discount from orders where id='${discounted.data.order.id}'`), "2500");
  const discountedDto = (await request("/api/merchant/orders?status=all", { cookie: restaurant.cookie })).data.orders.find((order) => order.id === discounted.data.order.id);
  assert.equal(discountedDto.discount, 2500); assert.equal(discountedDto.offerCode, "SAVE10");
  // Staff roles: owner-managed access, server-side permission checks and soft removal.
  const invited = await request("/api/merchant/staff", { method: "POST", cookie: restaurant.cookie, body: { email: emails[2], role: "kitchen" } });
  assert.equal(invited.status, 201); assert.equal(invited.data.staff.role, "kitchen");
  assert.equal((await request("/api/merchant/staff", { method: "POST", cookie: restaurant.cookie, body: { email: emails[2], role: "manager" } })).status, 409);
  assert.equal((await request("/api/merchant/staff", { cookie: reassignTarget.cookie })).status, 403);
  const staffAuth = await request("/api/auth", { cookie: reassignTarget.cookie });
  assert.equal(staffAuth.data.business.id, restaurant.business.id); assert.equal(staffAuth.data.role, "kitchen");
  assert.equal((await request("/api/merchant/compliance", { cookie: reassignTarget.cookie })).status, 403);
  assert.equal((await request("/api/merchant/orders", { cookie: reassignTarget.cookie })).status, 200);
  assert.equal((await request("/api/merchant/menu", { method: "PATCH", cookie: reassignTarget.cookie, body: { action: "availability", id: rItem.data.item.id, available: false } })).status, 403);
  assert.equal((await request("/api/merchant/offers", { cookie: reassignTarget.cookie })).status, 403);
  assert.equal((await request("/api/merchant/staff", { method: "POST", cookie: reassignTarget.cookie, body: { email: emails[1], role: "server" } })).status, 403);
  assert.equal((await transition(reassignTarget.cookie, discounted.data.order.id, "new", "accepted", { prepMinutes: 15 })).status, 200);
  const promoted = await request("/api/merchant/staff", { method: "PATCH", cookie: restaurant.cookie, body: { id: invited.data.staff.id, role: "manager" } });
  assert.equal(promoted.status, 200); assert.equal(promoted.data.staff.role, "manager");
  assert.equal((await request("/api/merchant/offers", { cookie: reassignTarget.cookie })).status, 200);
  assert.equal((await request("/api/merchant/staff", { cookie: reassignTarget.cookie })).status, 403);
  const managerOffer = await request("/api/merchant/offers", { method: "POST", cookie: reassignTarget.cookie, body: offerBody("MGR10") });
  assert.equal(managerOffer.status, 201);

  const managerCompliance = await request("/api/merchant/compliance", { cookie: reassignTarget.cookie });
  assert.equal(managerCompliance.status, 200);
  assert.equal((await request("/api/merchant/compliance", { method: "PATCH", cookie: reassignTarget.cookie, body: { legalName: "Not allowed" } })).status, 403);
  assert.equal((await request("/api/merchant/offers", { method: "DELETE", cookie: restaurant.cookie, body: { id: managerOffer.data.offer.id } })).status, 200);
  assert.equal((await request("/api/merchant/staff", { method: "PATCH", cookie: restaurant.cookie, body: { id: invited.data.staff.id, action: "remove" } })).status, 200);
  assert.equal((await request("/api/auth", { cookie: reassignTarget.cookie })).data.business, null);
  assert.equal((await request("/api/merchant/orders", { cookie: reassignTarget.cookie })).status, 404);
  const reinvited = await request("/api/merchant/staff", { method: "POST", cookie: restaurant.cookie, body: { email: emails[2], role: "server" } });
  assert.equal(reinvited.status, 200); assert.equal(reinvited.data.staff.id, invited.data.staff.id); assert.equal(reinvited.data.staff.role, "server");
  assert.equal((await request("/api/merchant/staff", { method: "DELETE", cookie: restaurant.cookie, body: { id: invited.data.staff.id } })).status, 200);
  assert.ok(Number(scalar(`select count(*) from audit_logs where event='staff.permission_denied' and outcome='denied' and business_id='${restaurant.business.id}'`)) >= 3);
  assert.equal(scalar(`select count(*) from audit_logs where event='staff.invited' and outcome='success' and business_id='${restaurant.business.id}' and detail->>'targetUserId'='${reassignTarget.data.user.id}'`), "1");
  assert.equal((await request("/api/merchant/business", { method: "PATCH", cookie: restaurant.cookie, body: { action: "settings", pickupEnabled: true, deliveryEnabled: true, hoursEnabled: false, opensAt: "09:00", closesAt: "22:00" } })).status, 200);
  const deliveryPayload = { ...payload, idempotencyKey: randomUUID(), fulfilment: "delivery" };
  assert.equal((await request("/api/marketplace", { method: "POST", body: deliveryPayload })).status, 400);
  const delivery = await request("/api/marketplace", { method: "POST", body: { ...deliveryPayload, deliveryAddress: "Test delivery address" } }); assert.equal(delivery.status, 201);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "new", "accepted", { prepMinutes: 20 })).status, 200);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "accepted", "preparing")).status, 200);
  // A local delivery order goes straight to out-for-delivery when marked ready, and attempts dispatch.
  const handedOff = await transition(restaurant.cookie, delivery.data.order.id, "preparing", "ready");
  assert.equal(handedOff.status, 200); assert.equal(handedOff.data.order.status, "out_for_delivery"); assert.ok(handedOff.data.dispatch);
  assert.equal(scalar(`select count(*) from order_events where order_id='${delivery.data.order.id}' and reason='Automatic handoff when marked ready'`), "1");
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "ready", "completed")).status, 409);
  // The automatic handoff racing a fulfilment change must never leave a pickup order with a rider.
  const raceKey = randomUUID();
  const raceOrder = await request("/api/marketplace", { method: "POST", body: { ...deliveryPayload, idempotencyKey: raceKey, deliveryAddress: "Race delivery address" } });
  assert.equal(raceOrder.status, 201);
  assert.equal((await transition(restaurant.cookie, raceOrder.data.order.id, "new", "accepted", { prepMinutes: 20 })).status, 200);
  assert.equal((await transition(restaurant.cookie, raceOrder.data.order.id, "accepted", "preparing")).status, 200);
  const [handoffRace, switched] = await Promise.all([
    transition(restaurant.cookie, raceOrder.data.order.id, "preparing", "ready"),
    request("/api/merchant/orders", { method: "PATCH", cookie: restaurant.cookie, body: { id: raceOrder.data.order.id, fulfilment: "pickup" } }),
  ]);
  // If the fulfilment switch wins the row lock, the order is ready for pickup instead of dispatched.
  assert.equal(handoffRace.status, 200);
  assert.ok(switched.status === 200 || switched.status === 409);
  const racedTracking = await request(`/api/marketplace?orderId=${raceOrder.data.order.id}&token=${raceKey}`);
  assert.ok(!(racedTracking.data.order.status === "out_for_delivery" && racedTracking.data.order.fulfilment === "pickup"));
  // Provider seam: signed webhooks update order state idempotently and reject stale/replayed events.
  const courierSecret = process.env.COURIER_WEBHOOK_SECRET ?? "", paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
  const providerEventsEnabled = courierSecret.length >= 32 && paymentSecret.length >= 32;
  if (providerEventsEnabled) {
    const providerOrder = await request("/api/marketplace", { method: "POST", body: { ...deliveryPayload, idempotencyKey: randomUUID(), deliveryAddress: "Provider test address" } });
    assert.equal(providerOrder.status, 201);
    for (const [from, to, extra] of [["new", "accepted", { prepMinutes: 10 }], ["accepted", "preparing", {}], ["preparing", "ready", {}]]) {
      const result = await transition(restaurant.cookie, providerOrder.data.order.id, from, to, extra);
      assert.equal(result.status, 200);
      if (to === "ready") { assert.equal(result.data.order.status, "out_for_delivery"); assert.ok(result.data.dispatch); }
    }
    const base = { eventId: `courier_${run}`, businessId: restaurant.business.id, orderId: providerOrder.data.order.id, occurredAt: new Date(Date.now() - 120000).toISOString() };
    const assigned = { ...base, type: "assigned", trackingId: "TRACK-PROVIDER" };
    assert.equal((await signedProviderEvent("/api/integration/courier", courierSecret, assigned, { signingSecret: "x".repeat(32) })).status, 401);
    assert.equal((await signedProviderEvent("/api/integration/courier", courierSecret, assigned, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
    assert.equal((await signedProviderEvent("/api/integration/courier", courierSecret, { ...assigned, type: "paid" })).status, 400);
    assert.equal((await signedProviderEvent("/api/integration/courier", courierSecret, { ...assigned, orderId: randomUUID() })).status, 404);
    const first = await signedProviderEvent("/api/integration/courier", courierSecret, assigned);
    assert.equal(first.status, 200); assert.equal(first.data.outcome, "applied"); assert.equal(first.data.courierStatus, "assigned");
    const replay = await signedProviderEvent("/api/integration/courier", courierSecret, assigned);
    assert.equal(replay.status, 200); assert.equal(replay.data.outcome, "duplicate");
    const stale = await signedProviderEvent("/api/integration/courier", courierSecret, { ...base, eventId: `courier_stale_${run}`, type: "picked_up", occurredAt: new Date(Date.now() - 180000).toISOString() });
    assert.equal(stale.status, 200); assert.equal(stale.data.outcome, "ignored");
    const delivered = await signedProviderEvent("/api/integration/courier", courierSecret, { ...base, eventId: `courier_done_${run}`, type: "delivered", occurredAt: new Date(Date.now() - 60000).toISOString() });
    assert.equal(delivered.status, 200); assert.equal(delivered.data.outcome, "applied"); assert.equal(delivered.data.status, "completed");
    const paid = await signedProviderEvent("/api/integration/payment", paymentSecret, { eventId: `payment_${run}`, businessId: restaurant.business.id, orderCode: String(providerOrder.data.order.orderNumber), type: "paid", occurredAt: new Date(Date.now() - 30000).toISOString(), reference: `PAY-${run}` });
    assert.equal(paid.status, 200); assert.equal(paid.data.outcome, "applied"); assert.equal(paid.data.paymentStatus, "paid");
    const stalePayment = await signedProviderEvent("/api/integration/payment", paymentSecret, { eventId: `payment_stale_${run}`, businessId: restaurant.business.id, orderId: providerOrder.data.order.id, type: "failed", occurredAt: new Date(Date.now() - 90000).toISOString() });
    assert.equal(stalePayment.status, 200); assert.equal(stalePayment.data.outcome, "ignored");
    const providerDto = (await request("/api/merchant/orders?status=all", { cookie: restaurant.cookie })).data.orders.find((order) => order.id === providerOrder.data.order.id);
    assert.equal(providerDto.status, "completed"); assert.equal(providerDto.courierStatus, "delivered"); assert.equal(providerDto.courierTrackingId, "TRACK-PROVIDER");
    assert.equal(providerDto.paymentStatus, "paid"); assert.equal(providerDto.paymentReference, `PAY-${run}`);
    assert.equal(scalar(`select count(*) from provider_events where order_id='${providerOrder.data.order.id}' and outcome='applied'`), "3");
    assert.equal(scalar(`select count(*) from provider_events where order_id='${providerOrder.data.order.id}' and outcome='ignored'`), "2");
    assert.equal(scalar(`select count(*) from order_events where order_id='${providerOrder.data.order.id}' and reason='Courier assigned via webhook'`), "1");
    assert.equal(scalar(`select count(*) from order_events where order_id='${providerOrder.data.order.id}' and reason='Courier delivered via webhook'`), "1");
    assert.equal(scalar(`select count(*) from order_events where order_id='${providerOrder.data.order.id}' and reason='Payment paid via webhook'`), "1");
    const payments = await request("/api/merchant/payments", { cookie: restaurant.cookie });
    assert.equal(payments.status, 200);
    assert.equal(payments.data.available, true);
    assert.ok(payments.data.attempts.some((attempt) => attempt.orderId === providerOrder.data.order.id && attempt.status === "paid" && attempt.providerReference === `PAY-${run}`));
    assert.ok(payments.data.counts.paid >= 1);
    assert.ok(Number(scalar(`select count(*) from audit_logs where event='provider_event.rejected' and outcome='denied' and detail->>'provider'='courier'`)) >= 2);
  } else console.warn("Skipping signed provider webhook assertions: set COURIER_WEBHOOK_SECRET and PAYMENT_WEBHOOK_SECRET (32+ chars each).");
  assert.equal((await transition(vendor.cookie, vOrder.data.order.id, "new", "rejected", { reason: "Sold out" })).status, 200);
  const second = await request("/api/marketplace", { method: "POST", body: { ...vPayload, idempotencyKey: randomUUID() } }); assert.equal(second.status, 201);
  assert.equal((await transition(vendor.cookie, second.data.order.id, "new", "accepted", { prepMinutes: 15 })).status, 200);
  await request("/api/merchant/business", { method: "PATCH", cookie: vendor.cookie, body: { action: "availability", isOpen: false } });
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...vPayload, idempotencyKey: randomUUID() } })).status, 409);
  const retained = await request("/api/merchant/orders?status=accepted", { cookie: vendor.cookie }); assert.ok(retained.data.orders.some((o) => o.id === second.data.order.id));
  await request("/api/merchant/business", { method: "PATCH", cookie: vendor.cookie, body: { action: "availability", isOpen: true } });
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()).split(":").map(Number);
  const minute = parts[0] * 60 + parts[1], clock = (n) => `${String(Math.floor((n % 1440) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  const schedule = { action: "settings", pickupEnabled: true, deliveryEnabled: false, hoursEnabled: true, opensAt: clock(minute + 120), closesAt: clock(minute + 180) };
  assert.equal((await request("/api/merchant/business", { method: "PATCH", cookie: vendor.cookie, body: schedule })).status, 200);
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...vPayload, idempotencyKey: randomUUID() } })).status, 409);
  await request("/api/merchant/business", { method: "PATCH", cookie: vendor.cookie, body: { ...schedule, hoursEnabled: false } });
  assert.equal((await request("/api/merchant/menu", { method: "PATCH", cookie: vendor.cookie, body: { action: "availability", id: vItem.data.item.id, available: false } })).status, 200);
  const publicMenu = await request(`/api/marketplace?businessId=${vendor.business.id}`); assert.ok(!publicMenu.data.items.some((item) => item.id === vItem.data.item.id));
  assert.equal((await request("/api/marketplace", { method: "POST", body: { ...vPayload, idempotencyKey: randomUUID() } })).status, 409);
  const edited = await request("/api/merchant/menu", { method: "PATCH", cookie: restaurant.cookie, body: { ...itemBody, id: rItem.data.item.id, name: "Updated meal", price: 30000 } }); assert.equal(edited.data.item.price, 30000);
  const updatedPublicMenu = await request(`/api/marketplace?businessId=${restaurant.business.id}`); assert.equal(updatedPublicMenu.data.items.find((item) => item.id === rItem.data.item.id).price, 30000);
  const settlementExternal = `settle_${run}`, settlementOrder = `order_${run}`;
  sql(`insert into settlements (business_id, external_id, marketplace_order_id, order_number, amount, gross_amount, commission_amount, refund_amount, adjustment_amount, currency, status, reference, paid_at, source_updated_at) values ('${restaurant.business.id}', '${settlementExternal}', '${settlementOrder}', 2847, 54999, 56700, 1701, 0, 0, 'INR', 'paid', 'PAYOUT_${run}', now(), now())`);
  const earnings = await request("/api/merchant/overview", { cookie: restaurant.cookie }); assert.equal(earnings.data.overview.todaySales, providerEventsEnabled ? 100000 : 50000); assert.equal(earnings.data.overview.completedToday, providerEventsEnabled ? 2 : 1);
  assert.equal(earnings.data.overview.settlements.length, 1);
  assert.deepEqual({ ...earnings.data.overview.settlements[0], id: undefined, paidAt: undefined, sourceUpdatedAt: undefined, createdAt: undefined }, { id: undefined, externalId: settlementExternal, marketplaceOrderId: settlementOrder, orderNumber: 2847, netAmount: 54999, grossAmount: 56700, commissionAmount: 1701, refundAmount: 0, adjustmentAmount: 0, currency: "INR", status: "paid", reference: `PAYOUT_${run}`, paidAt: undefined, sourceUpdatedAt: undefined, createdAt: undefined });
  assert.equal(earnings.data.overview.settlementSync.linked, false);
  const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const insights = await request(`/api/merchant/analytics?from=${todayIst}&to=${todayIst}`, { cookie: restaurant.cookie });
  assert.equal(insights.status, 200);
  assert.equal(insights.data.analytics.source, "local");
  assert.ok(insights.data.analytics.kpis.ordersPlaced >= 1);
  assert.equal(insights.data.analytics.daily.length, 1);
  assert.equal(insights.data.analytics.daily[0].date, todayIst);
  assert.equal(insights.data.analytics.fulfilment.length, 2);
  assert.ok(insights.data.analytics.payments.length >= 1);
  const analyticsStaff = await request("/api/merchant/staff", { method: "POST", cookie: restaurant.cookie, body: { email: emails[2], role: "server" } });
  assert.equal(analyticsStaff.status, 200);
  assert.equal((await request("/api/merchant/analytics", { cookie: reassignTarget.cookie })).status, 403);
  assert.equal((await request("/api/merchant/staff", { method: "DELETE", cookie: restaurant.cookie, body: { id: analyticsStaff.data.staff.id } })).status, 200);
  let duplicateSettlementRejected = false;
  try { sql(`insert into settlements (business_id, external_id, marketplace_order_id, amount, status, source_updated_at) values ('${restaurant.business.id}', 'settle_dup_${run}', '${settlementOrder}', 100, 'paid', now())`); } catch { duplicateSettlementRejected = true; }
  assert.equal(duplicateSettlementRejected, true);
  // Signing in again from another browser must not disturb the existing session, but signing in with a
  // token already in that browser must rotate it away.
  const extraLogin = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(extraLogin.status, 200); assert.ok(extraLogin.cookie); assert.notEqual(extraLogin.cookie, restaurant.cookie); assert.equal(extraLogin.data.verificationRequired, false);
  assert.ok((await request("/api/auth", { cookie: restaurant.cookie })).data.user);
  const rotated = await request("/api/auth", { method: "POST", cookie: restaurant.cookie, body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(rotated.status, 200); assert.ok(rotated.cookie);
  assert.equal((await request("/api/auth", { cookie: restaurant.cookie })).data.user, null);
  assert.ok((await request("/api/auth", { cookie: rotated.cookie })).data.user);
  assert.equal((await request("/api/auth", { method: "POST", cookie: rotated.cookie, body: { action: "logout-all" } })).status, 200);
  assert.equal((await request("/api/auth", { cookie: rotated.cookie })).data.user, null);
  assert.equal((await request("/api/auth", { cookie: extraLogin.cookie })).data.user, null);
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.logout_all' and outcome='success' and actor_user_id=(select id from users where email='${emails[0]}')`), "1");
  // An idle-expired session is rejected and removed; an old session with recent use slides its expiry
  // forward but still dies at the absolute lifetime.
  const tokenHash = hash;
  sql(`update sessions set expires_at = now() - interval '1 minute' where token_hash = '${tokenHash(vendor.cookie.split("=")[1])}'`);
  assert.equal((await request("/api/auth", { cookie: vendor.cookie })).data.user, null);
  const vendorLogin = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: `T3st-${run}` } });
  assert.equal(vendorLogin.status, 200); assert.ok(vendorLogin.cookie);
  const vendorToken = tokenHash(vendorLogin.cookie.split("=")[1]);
  sql(`update sessions set expires_at = now() + interval '10 days' where token_hash = '${vendorToken}'`);
  assert.ok((await request("/api/auth", { cookie: vendorLogin.cookie })).data.user);
  assert.equal(scalar(`select expires_at > now() + interval '29 days' from sessions where token_hash = '${vendorToken}'`), "t");
  sql(`update sessions set created_at = now() - interval '91 days' where token_hash = '${vendorToken}'`);
  assert.equal((await request("/api/auth", { cookie: vendorLogin.cookie })).data.user, null);
  // Changing a password requires the current one, rotates the session and revokes the other devices.
  const newPassword = `N3w-${run}`;
  const passwordLogin = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: `T3st-${run}` } });
  assert.equal(passwordLogin.status, 200); assert.ok(passwordLogin.cookie);
  assert.equal((await request("/api/auth", { method: "POST", cookie: passwordLogin.cookie, body: { action: "change-password", currentPassword: "wrong-password", newPassword } })).status, 403);
  const changed = await request("/api/auth", { method: "POST", cookie: passwordLogin.cookie, body: { action: "change-password", currentPassword: `T3st-${run}`, newPassword } });
  assert.equal(changed.status, 200); assert.ok(changed.cookie); assert.notEqual(changed.cookie, passwordLogin.cookie);
  assert.equal((await request("/api/auth", { cookie: passwordLogin.cookie })).data.user, null);
  assert.equal((await request("/api/auth", { cookie: changed.cookie })).data.user.email, emails[1]);
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: `T3st-${run}` } })).status, 401);
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: newPassword } })).status, 200);
  // A reset link is single use, revokes every session and issues a fresh one for this browser.
  const resetToken = `p${run}`, resetPassword = `R3s-${run}`;
  const beforeReset = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: newPassword } });
  assert.equal(beforeReset.status, 200);
  accountToken(resetToken, emails[1], "reset_password");
  const reset = await request("/api/auth", { method: "POST", cookie: beforeReset.cookie, body: { action: "reset-password", token: resetToken, password: resetPassword } });
  assert.equal(reset.status, 200); assert.ok(reset.cookie); assert.notEqual(reset.cookie, beforeReset.cookie);
  assert.equal((await request("/api/auth", { cookie: beforeReset.cookie })).data.user, null);
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: newPassword } })).status, 401);
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "login", email: emails[1], password: resetPassword } })).status, 200);
  assert.equal((await request("/api/auth", { method: "POST", body: { action: "reset-password", token: resetToken, password: resetPassword } })).status, 400);
  assert.equal(scalar(`select consumed_at is not null from account_tokens where token_hash='${hash(resetToken)}'`), "t");
  const vendorId = scalar(`select id from users where email='${emails[1]}'`);
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.login' and outcome='failure' and actor_email_hash='${hash(emails[1])}'`), "2");
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.change_password' and outcome='failure' and actor_user_id='${vendorId}' and detail->>'reason'='invalid_current_password'`), "1");
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.change_password' and outcome='success' and actor_user_id='${vendorId}' and detail->>'sessionsRevoked'='true'`), "1");
  assert.equal(scalar(`select count(*) from audit_logs where detail::text like '%T3st-%' or detail::text like '%N3w-%' or detail::text like '%R3s-%' or detail::text like '%@example.test%'`), "0");
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.verify_email' and outcome='success' and actor_user_id in (${owners})`), "2");
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.reset_password' and outcome='success' and actor_user_id='${vendorId}' and detail->>'sessionsRevoked'='true'`), "1");
  assert.equal(scalar(`select count(*) from audit_logs where event='auth.forgot_password' and actor_email_hash='${hash(missingEmail)}' and detail->>'accountFound'='false'`), "1");
  // A business created under the wrong account can be recovered by an authenticated server.
  assert.equal((await adminOwnerRequest({ businessId: vendor.business.id, email: missingEmail })).status, 404);
  const reassigned = await adminOwnerRequest({ businessId: vendor.business.id, email: emails[2] });
  assert.equal(reassigned.status, 200); assert.equal(reassigned.data.business.ownerId, reassignTarget.data.user.id);
  assert.equal((await request("/api/auth", { cookie: vendor.cookie })).data.business, null);
  assert.equal((await request("/api/auth", { cookie: reassignTarget.cookie })).data.business.id, vendor.business.id);
  // The destination may already own other outlets; no conflict is raised.
  assert.equal((await adminOwnerRequest({ businessId: restaurant.business.id, email: emails[2] })).status, 200);
  assert.equal((await request("/api/auth", { cookie: reassignTarget.cookie })).data.businesses.length, 2);
  assert.equal((await adminOwnerRequest({ businessId: restaurant.business.id, email: emails[0] })).status, 200);
  assert.equal((await adminOwnerRequest({ businessId: vendor.business.id, email: emails[1] })).status, 200);
  assert.equal(scalar(`select count(*) from audit_logs where event='admin.reassign_owner' and outcome='success' and business_id='${vendor.business.id}' and detail->>'newOwnerId'='${reassignTarget.data.user.id}'`), "1");
  assert.equal(scalar(`select count(*) from audit_logs where event='admin.reassign_owner' and outcome='failure' and business_id='${vendor.business.id}' and detail->>'reason'='target_not_found'`), "1");
  // Multi-outlet: one owner, two outlets, per-session selection and strict per-outlet scoping.
  const ownerSession = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(ownerSession.status, 200); assert.ok(ownerSession.cookie);
  assert.equal(ownerSession.data.business.id, restaurant.business.id);
  const secondOutlet = await request("/api/merchant/business", { method: "POST", cookie: ownerSession.cookie, body: { type: "restaurant", createNew: true } });
  assert.equal(secondOutlet.status, 201);
  extraOutletIds.push(secondOutlet.data.business.id);
  assert.notEqual(secondOutlet.data.business.id, restaurant.business.id);
  assert.equal(scalar(`select count(*) from businesses where owner_id=(select id from users where email='${emails[0]}')`), "2");
  const afterAdd = await request("/api/auth", { cookie: ownerSession.cookie });
  assert.equal(afterAdd.data.business.id, secondOutlet.data.business.id);
  assert.equal(afterAdd.data.businesses.length, 2);
  assert.ok(afterAdd.data.businesses.every((entry) => entry.role === "owner"));
  // A fresh sign-in for the same owner starts on the default outlet: selection is per session.
  const otherSession = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(otherSession.status, 200); assert.ok(otherSession.cookie);
  assert.equal(otherSession.data.business.id, restaurant.business.id);
  assert.equal((await request("/api/merchant/active-business", { cookie: otherSession.cookie })).data.activeBusinessId, restaurant.business.id);
  assert.ok((await request("/api/merchant/orders", { cookie: otherSession.cookie })).data.orders.length > 0);
  const switchedOutlet = await request("/api/merchant/active-business", { method: "POST", cookie: otherSession.cookie, body: { businessId: secondOutlet.data.business.id } });
  assert.equal(switchedOutlet.status, 200);
  assert.equal(switchedOutlet.data.business.id, secondOutlet.data.business.id);
  assert.equal(switchedOutlet.data.businesses.length, 2);
  // Switching only changes this session and every scoped API reads the new outlet.
  assert.equal((await request("/api/auth", { cookie: ownerSession.cookie })).data.business.id, secondOutlet.data.business.id);
  const switchedOrders = await request("/api/merchant/orders", { cookie: otherSession.cookie });
  assert.equal(switchedOrders.status, 200);
  assert.equal(switchedOrders.data.orders.length, 0);
  // A client cannot select an outlet it neither owns nor staffs.
  const rejected = await request("/api/merchant/active-business", { method: "POST", cookie: otherSession.cookie, body: { businessId: vendor.business.id } });
  assert.equal(rejected.status, 403);
  assert.equal((await request("/api/auth", { cookie: otherSession.cookie })).data.business.id, secondOutlet.data.business.id);
  // Staff access is per outlet with its own role.
  const crossStaff = await request("/api/merchant/staff", { method: "POST", cookie: ownerSession.cookie, body: { email: emails[2], role: "server" } });
  assert.equal(crossStaff.status, 201);
  const staffSwitch = await request("/api/merchant/active-business", { method: "POST", cookie: reassignTarget.cookie, body: { businessId: secondOutlet.data.business.id } });
  assert.equal(staffSwitch.status, 200);
  assert.equal(staffSwitch.data.role, "server");
  assert.equal((await request("/api/merchant/staff", { cookie: reassignTarget.cookie })).status, 403);
  assert.equal((await request("/api/merchant/active-business", { method: "POST", cookie: reassignTarget.cookie, body: { businessId: restaurant.business.id } })).status, 403);
  // Each outlet resolves its own pairing link; a linked branch never marks the other branch linked.
  sql(`insert into business_marketplace_links (id, business_id, marketplace_restaurant_id, marketplace_restaurant_name, marketplace_restaurant_slug, access_token_encrypted) values ('${randomUUID()}', '${secondOutlet.data.business.id}', 999001, 'Smoke branch', 'smoke-branch', 'encrypted-not-used')`);
  const linkedAuth = await request("/api/auth", { cookie: ownerSession.cookie });
  assert.equal(linkedAuth.data.businesses.find((entry) => entry.id === secondOutlet.data.business.id).linked, true);
  assert.equal(linkedAuth.data.businesses.find((entry) => entry.id === restaurant.business.id).linked, false);
  sql(`delete from business_marketplace_links where business_id='${secondOutlet.data.business.id}'`);
  // Owner recovery may now point an outlet at an account that already owns other outlets.
  const multiOwnerReassignment = await adminOwnerRequest({ businessId: vendor.business.id, email: emails[0] });
  assert.equal(multiOwnerReassignment.status, 200);
  assert.equal((await request("/api/auth", { cookie: ownerSession.cookie })).data.businesses.length, 3);
  assert.equal((await adminOwnerRequest({ businessId: vendor.business.id, email: emails[1] })).status, 200);
  console.log("PASS: security headers, opt-in verification gate, registration, approval, owner recovery, marketplace, concurrency, feedback and replies, offers and server-side discounts, staff roles and permissions, multi-outlet ownership and session-scoped switching, signed courier/payment webhooks, sessions, password change, hashed audit trail, email verification, single-use password reset and authoritative settlement mirror, compliance permissions and pro forma invoices");
} finally {
  try { sql(`begin; delete from audit_logs where actor_user_id in (${owners}) or business_id in (${shopIds()}) or actor_email_hash in (${emailHashes}) or (event in ('auth.verify_email','auth.reset_password') and outcome='failure'); delete from account_tokens where user_id in (${owners}); delete from order_events where order_id in (${testOrders()}); delete from order_items where order_id in (${testOrders()}); delete from provider_events where order_id in (${testOrders()}); delete from payment_attempts where order_id in (${testOrders()}); delete from orders where business_id in (${shopIds()}); delete from offers where business_id in (${shopIds()}); delete from staff_members where business_id in (${shopIds()}); delete from menu_items where business_id in (${shopIds()}); delete from settlements where business_id in (${shopIds()}); delete from tax_invoices where business_id in (${shopIds()}); delete from compliance_documents where business_id in (${shopIds()}); delete from compliance_agreement_acceptances where business_id in (${shopIds()}); delete from business_compliance where business_id in (${shopIds()}); delete from settlements where business_id in (${shopIds()}); delete from business_marketplace_links where business_id in (${shopIds()}); delete from sessions where user_id in (${owners}); delete from businesses where id in (${shopIds()}); delete from users where id in (${owners}); commit;`); }
  catch (error) { console.error("Could not clean up disposable test records:", error.message); process.exitCode = 1; }
}
