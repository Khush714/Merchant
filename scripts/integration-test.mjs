import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const database = process.env.DATABASE_URL;
if (!database || !["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) throw new Error("This disposable smoke test requires a local DATABASE_URL.");
const run = randomUUID().replaceAll("-", "");
const emails = [`restaurant-${run}@example.test`, `vendor-${run}@example.test`];
const owners = `select id from users where email in ('${emails[0]}','${emails[1]}')`;
const shops = `select id from businesses where owner_id in (${owners})`;
const testOrders = `select id from orders where business_id in (${shops})`;
function sql(statement) { execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], { stdio: "pipe" }); }
function scalar(statement) { return execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", statement], { encoding: "utf8" }).trim(); }
async function request(path, { method = "GET", cookie, body } = {}) {
  const send = () => fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let response = await send();
  // The auth bucket allows a fixed number of requests per IP per minute. A repeated run started
  // shortly after a previous one can trip it; wait for the window once instead of failing the run.
  if (response.status === 429) {
    console.warn("Rate limited; waiting 61s for the per-IP window to reset, then retrying once.");
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    response = await send();
  }
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
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
  const csp = health.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-frame-options"), "DENY");
  assert.equal(health.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(health.headers.get("strict-transport-security") ?? "", /max-age=/);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const missing = await fetch(`${base}/this-route-does-not-exist`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Page not found/);
  const unauth = await request("/api/merchant/orders"); assert.equal(unauth.status, 401);
  assert.equal((await request("/api/admin/approval", { method: "POST", body: { businessId: randomUUID(), status: "approved" } })).status, 403);
  assert.equal((await rawRequest("/api/marketplace", { body: "{not json", contentType: "application/json" })).status, 400);
  assert.equal((await rawRequest("/api/marketplace", { body: "businessId=1", contentType: "text/plain" })).status, 415);
  assert.equal((await rawRequest("/api/marketplace", { body: JSON.stringify({ padding: "x".repeat(140 * 1024) }), contentType: "application/json" })).status, 413);
  assert.equal((await rawRequest("/api/marketplace", { body: "", contentType: "application/json" })).status, 400);
  const restaurant = await account(emails[0], "restaurant"), vendor = await account(emails[1], "vendor");
  let marketplace = await request("/api/marketplace"); assert.ok(!marketplace.data.businesses.some((b) => [restaurant.business.id, vendor.business.id].includes(b.id)));
  // Simulate the trusted review system in a disposable local database.
  sql(`update businesses set approval_status='approved' where id in (${shops})`);
  for (const account of [restaurant, vendor]) { const opened = await request("/api/merchant/business", { method: "PATCH", cookie: account.cookie, body: { action: "availability", isOpen: true } }); assert.equal(opened.status, 200); }
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
  assert.equal((await transition(restaurant.cookie, placed.data.order.id, "ready", "completed")).status, 200);
  assert.equal((await request("/api/merchant/business", { method: "PATCH", cookie: restaurant.cookie, body: { action: "settings", pickupEnabled: true, deliveryEnabled: true, hoursEnabled: false, opensAt: "09:00", closesAt: "22:00" } })).status, 200);
  const deliveryPayload = { ...payload, idempotencyKey: randomUUID(), fulfilment: "delivery" };
  assert.equal((await request("/api/marketplace", { method: "POST", body: deliveryPayload })).status, 400);
  const delivery = await request("/api/marketplace", { method: "POST", body: { ...deliveryPayload, deliveryAddress: "Test delivery address" } }); assert.equal(delivery.status, 201);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "new", "accepted", { prepMinutes: 20 })).status, 200);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "accepted", "preparing")).status, 200);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "preparing", "ready")).status, 200);
  assert.equal((await transition(restaurant.cookie, delivery.data.order.id, "ready", "completed")).status, 409);
  // A dispatch and a fulfilment change racing on the same order must not both succeed.
  const [dispatched, switched] = await Promise.all([
    transition(restaurant.cookie, delivery.data.order.id, "ready", "out_for_delivery"),
    request("/api/merchant/orders", { method: "PATCH", cookie: restaurant.cookie, body: { id: delivery.data.order.id, fulfilment: "pickup" } }),
  ]);
  assert.deepEqual([dispatched.status, switched.status].sort(), [200, 409]);
  const racedTracking = await request(`/api/marketplace?orderId=${delivery.data.order.id}&token=${deliveryPayload.idempotencyKey}`);
  assert.ok(!(racedTracking.data.order.status === "out_for_delivery" && racedTracking.data.order.fulfilment === "pickup"));
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
  const earnings = await request("/api/merchant/overview", { cookie: restaurant.cookie }); assert.equal(earnings.data.overview.todaySales, 50000); assert.equal(earnings.data.overview.completedToday, 1); assert.equal(earnings.data.overview.settlements.length, 0);
  // Signing in again from another browser must not disturb the existing session, but signing in with a
  // token already in that browser must rotate it away.
  const extraLogin = await request("/api/auth", { method: "POST", body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(extraLogin.status, 200); assert.ok(extraLogin.cookie); assert.notEqual(extraLogin.cookie, restaurant.cookie);
  assert.ok((await request("/api/auth", { cookie: restaurant.cookie })).data.user);
  const rotated = await request("/api/auth", { method: "POST", cookie: restaurant.cookie, body: { action: "login", email: emails[0], password: `T3st-${run}` } });
  assert.equal(rotated.status, 200); assert.ok(rotated.cookie);
  assert.equal((await request("/api/auth", { cookie: restaurant.cookie })).data.user, null);
  assert.ok((await request("/api/auth", { cookie: rotated.cookie })).data.user);
  assert.equal((await request("/api/auth", { method: "POST", cookie: rotated.cookie, body: { action: "logout-all" } })).status, 200);
  assert.equal((await request("/api/auth", { cookie: rotated.cookie })).data.user, null);
  assert.equal((await request("/api/auth", { cookie: extraLogin.cookie })).data.user, null);
  // An idle-expired session is rejected and removed; an old session with recent use slides its expiry
  // forward but still dies at the absolute lifetime.
  const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
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
  console.log("PASS: security headers and 404 boundary, restaurant and vendor registration, draft resumption, approval, shared marketplace, idempotency, isolation, concurrent pickup and delivery lifecycle, scheduled availability, menu, authoritative earnings, session rotation, sign-out-all, sliding idle timeout, absolute lifetime and password change");
} finally {
  try { sql(`begin; delete from order_events where order_id in (${testOrders}); delete from order_items where order_id in (${testOrders}); delete from orders where business_id in (${shops}); delete from menu_items where business_id in (${shops}); delete from settlements where business_id in (${shops}); delete from sessions where user_id in (${owners}); delete from businesses where owner_id in (${owners}); delete from users where id in (${owners}); commit;`); }
  catch (error) { console.error("Could not clean up disposable test records:", error.message); process.exitCode = 1; }
}
