import assert from "node:assert/strict";
import {
  gatewayMode, razorpayAuthorization, checkoutSignature, verifyCheckoutSignature, providerReceipt,
} from "../src/lib/payment-provider-core.ts";

const base = { NODE_ENV: "development", PAYMENT_PROVIDER: "auto" };
assert.equal(gatewayMode(base), "dev");
assert.equal(gatewayMode({ ...base, NODE_ENV: "production" }), "unavailable", "production never silently simulates money");
assert.equal(gatewayMode({ ...base, PAYMENT_PROVIDER: "dev", NODE_ENV: "production" }), "unavailable");
assert.equal(gatewayMode({ ...base, RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "secret" }), "razorpay");
assert.equal(gatewayMode({ ...base, PAYMENT_PROVIDER: "razorpay" }), "unavailable");
assert.equal(gatewayMode({ ...base, PAYMENT_PROVIDER: "nonsense", RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b" }), "unavailable");

assert.equal(
  razorpayAuthorization("id", "secret"),
  `Basic ${Buffer.from("id:secret").toString("base64")}`,
);
const signature = checkoutSignature("secret", "order_1", "pay_1");
assert.equal(signature.length, 64);
assert.equal(verifyCheckoutSignature("secret", "order_1", "pay_1", signature), true);
assert.equal(verifyCheckoutSignature("other", "order_1", "pay_1", signature), false);
assert.equal(verifyCheckoutSignature("secret", "order_2", "pay_1", signature), false);
assert.equal(verifyCheckoutSignature("secret", "order_1", "pay_1", "short"), false);
assert.match(providerReceipt("11111111-1111-4111-8111-111111111111", 2847, "attempt-id"), /^merchant_11111111_2847_attempti$/);

console.log("PASS: payment gateway mode and checkout signature rules");
