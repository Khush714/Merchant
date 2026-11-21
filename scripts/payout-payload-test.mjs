import assert from "node:assert/strict";
import { parsePayoutFeed, PayoutPayloadError } from "../src/lib/payout-payload.ts";

const feed = parsePayoutFeed({
  ok: true,
  payouts: [{
    reference: "UTR-123", methodLabel: "Bank ****1234", status: "paid", amountPaise: 9400,
    initiatedAt: "2026-11-20T10:00:00Z", completedAt: "2026-11-21T10:00:00Z",
    allocations: [{ settlementExternalId: "settle-1", amountPaise: 9400 }],
  }],
});
assert.equal(feed.available, true);
assert.equal(feed.payouts[0].reference, "UTR-123");
assert.equal(feed.payouts[0].allocations[0].amountPaise, 9400);

const unavailable = parsePayoutFeed({ available: false, message: "No payout endpoint yet" });
assert.equal(unavailable.available, false);
assert.match(unavailable.message, /No payout endpoint/);

for (const bad of [
  { ok: true, payouts: [{ reference: "", amountPaise: 1 }] },
  { ok: true, payouts: [{ reference: "UTR", amountPaise: -1 }] },
  { ok: true, payouts: [{ reference: "UTR", amountPaise: 1, allocations: [{ settlementExternalId: "", amountPaise: 1 }] }] },
  { ok: true, payouts: "nope" },
]) assert.throws(() => parsePayoutFeed(bad), PayoutPayloadError);

console.log("PASS: optional payout feed parsing");
