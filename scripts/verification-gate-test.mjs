import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const database = process.env.DATABASE_URL;
if (!database || !["127.0.0.1", "localhost", "::1"].includes(new URL(database).hostname)) throw new Error("This disposable smoke test requires a local DATABASE_URL.");
if ((process.env.REQUIRE_EMAIL_VERIFICATION ?? "").trim().toLowerCase() !== "true") throw new Error("Start the server with REQUIRE_EMAIL_VERIFICATION=true before running this test.");
const run = randomUUID().replaceAll("-", "");
const email = `gate-${run}@example.test`;
const password = `T3st-${run}`;
const newPassword = `N3w-${run}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const owners = `select id from users where email='${email}'`;
const shops = `select id from businesses where owner_id in (${owners})`;
function sql(statement) { execFileSync("psql", [database, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], { stdio: "pipe" }); }
async function request(path, { method = "GET", cookie, body } = {}) {
  const send = () => fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let response = await send();
  if (response.status === 429) {
    console.warn("Rate limited; waiting 61s for the per-IP window to reset, then retrying once.");
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    response = await send();
  }
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
try {
  const registered = await request("/api/auth", { method: "POST", body: { action: "register", email, password } });
  assert.equal(registered.status, 201); assert.ok(registered.cookie);
  assert.equal(registered.data.verificationRequired, true);
  assert.equal(registered.data.user.emailVerified, false);
  // Account creation through the API is gated, so seed the local business directly.
  sql(`insert into businesses (owner_id) values ((select id from users where email='${email}'))`);
  const session = await request("/api/auth", { cookie: registered.cookie });
  assert.equal(session.data.verificationRequired, true);
  assert.equal(session.data.user.emailVerified, false);
  const blocked = await request("/api/merchant/overview", { cookie: registered.cookie });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Verify your email/);
  // Recovery actions stay available while the gate is on.
  const resent = await request("/api/auth", { method: "POST", cookie: registered.cookie, body: { action: "resend-verification" } });
  assert.equal(resent.status, 200);
  const changed = await request("/api/auth", { method: "POST", cookie: registered.cookie, body: { action: "change-password", currentPassword: password, newPassword } });
  assert.equal(changed.status, 200); assert.ok(changed.cookie);
  assert.equal((await request("/api/merchant/overview", { cookie: changed.cookie })).status, 403);
  const token = `vg${run}`;
  sql(`insert into account_tokens (token_hash, user_id, purpose, expires_at) values ('${hash(token)}', (select id from users where email='${email}'), 'verify_email', now() + interval '1 hour')`);
  const verified = await request("/api/auth", { method: "POST", body: { action: "verify-email", token } });
  assert.equal(verified.status, 200);
  assert.equal((await request("/api/auth", { cookie: changed.cookie })).data.user.emailVerified, true);
  assert.equal((await request("/api/merchant/overview", { cookie: changed.cookie })).status, 200);
  console.log("PASS: opt-in verification gate blocks unverified merchant access, allows recovery, and opens access after verification");
} finally {
  try { sql(`begin; delete from audit_logs where actor_user_id in (${owners}) or actor_email_hash='${hash(email)}' or business_id in (${shops}); delete from account_tokens where user_id in (${owners}); delete from sessions where user_id in (${owners}); delete from businesses where owner_id in (${owners}); delete from users where id in (${owners}); commit;`); }
  catch (error) { console.error("Could not clean up disposable test records:", error.message); process.exitCode = 1; }
}
