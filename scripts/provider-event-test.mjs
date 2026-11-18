import assert from "node:assert/strict";
import {
  parseProviderEvent, ProviderEventError, signatureHeader, verifyProviderSignature,
} from "../src/lib/provider-events.ts";

const businessId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const secret = "unit-test-webhook-secret-at-least-32-chars";
const event = {
  eventId: "courier_evt_1", businessId, orderId, type: "out_for_delivery",
  occurredAt: "2026-11-18T10:00:00Z", trackingId: "TRACK-1", reference: "",
};

const courier = parseProviderEvent("courier", event);
assert.equal(courier.eventId, "courier_evt_1");
assert.equal(courier.trackingId, "TRACK-1");
assert.equal(courier.orderCode, null);
const byCode = parseProviderEvent("payment", { ...event, eventId: "pay_evt_1", orderId: undefined, orderCode: "2847", type: "paid", reference: "PAY-1" });
assert.equal(byCode.orderCode, 2847);
assert.equal(byCode.type, "paid");

for (const bad of [
  { ...event, eventId: "bad id!" },
  { ...event, orderId: "not-a-uuid" },
  { ...event, orderId: undefined, orderCode: "0" },
  { ...event, orderId: undefined },
  { ...event, type: "paid" },
  { ...event, occurredAt: "yesterday" },
  { ...event, trackingId: "a".repeat(129) },
]) assert.throws(() => parseProviderEvent("courier", bad), ProviderEventError);
assert.throws(() => parseProviderEvent("unknown", event), ProviderEventError);

const raw = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000);
const header = signatureHeader(secret, raw, timestamp);
verifyProviderSignature(secret, raw, header);
assert.throws(() => verifyProviderSignature(secret, raw, header, Date.now() + 600_000), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, `${raw} `, header), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, raw, "t=1,v1=" + "0".repeat(64)), ProviderEventError);
assert.throws(() => verifyProviderSignature("too-short", raw, header), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, raw, null), ProviderEventError);

console.log("PASS: provider event validation and raw-body HMAC signatures");
