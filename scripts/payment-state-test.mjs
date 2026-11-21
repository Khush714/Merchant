import assert from "node:assert/strict";
import {
  nextPaymentState, verifyPaymentAmount, normalizeFailure, isPaymentEvent, PAYMENT_STATES,
} from "../src/lib/payment-state.ts";

const legal = [
  ["unpaid", "authorized", "authorized"],
  ["created", "paid", "paid"],
  ["authorized", "paid", "paid"],
  ["failed", "paid", "paid"],
  ["unpaid", "failed", "failed"],
  ["paid", "refunded", "refunded"],
];
for (const [current, event, expected] of legal) {
  const result = nextPaymentState(current, event);
  assert.deepEqual(result, { ok: true, state: expected, unchanged: false }, `${current} + ${event}`);
}

// Replays are idempotent.
assert.deepEqual(nextPaymentState("paid", "paid"), { ok: true, state: "paid", unchanged: true });

// Money cannot regress: no paid -> failed, no refunded -> anything, no failed -> refunded.
for (const [current, event] of [
  ["paid", "failed"], ["refunded", "paid"], ["refunded", "failed"], ["failed", "refunded"],
  ["unpaid", "refunded"], ["created", "refunded"],
]) {
  assert.equal(nextPaymentState(current, event).ok, false, `${current} + ${event} must be rejected`);
}

// Amounts are optional for legacy events but must match when supplied.
assert.equal(verifyPaymentAmount(null, 49900).ok, true);
assert.equal(verifyPaymentAmount(49900, 49900).ok, true);
assert.equal(verifyPaymentAmount(49899, 49900).ok, false);
assert.equal(verifyPaymentAmount(-1, 49900).ok, false);

assert.deepEqual(normalizeFailure("bad\ncause", "  Card  declined  "), { code: "bad cause", message: "Card  declined" });
assert.equal(normalizeFailure("", "x".repeat(500)).message.length, 200);
assert.equal(isPaymentEvent("paid"), true);
assert.equal(isPaymentEvent("delivered"), false);
assert.equal(PAYMENT_STATES.length, 6);

console.log("PASS: payment state machine, amount verification and failure normalisation");
