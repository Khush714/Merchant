import assert from "node:assert/strict";
import {
  parseProviderEvent, ProviderEventError, signatureHeader, verifyProviderSignature,
} from "../src/lib/provider-events.ts";
import { BodyLimitError, readBoundedText } from "../src/lib/body-limit.ts";

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

// Legacy events stay valid; payment metadata is optional but validated when present.
assert.equal(parseProviderEvent("payment", { ...event, eventId: "pay_legacy", type: "failed" }).amountPaise, null);
const withAmount = parseProviderEvent("payment", {
  ...event, eventId: "pay_amount", type: "paid", amountPaise: 49900,
  failureCode: "CARD_DECLINED", failureMessage: " Bank declined ",
});
assert.equal(withAmount.amountPaise, 49900);
assert.equal(withAmount.failureCode, "CARD_DECLINED");
for (const bad of [
  { ...event, eventId: "pay_bad_1", type: "paid", amountPaise: -1 },
  { ...event, eventId: "pay_bad_2", type: "paid", amountPaise: "49900" },
  { ...event, eventId: "pay_bad_3", type: "failed", failureMessage: "a".repeat(201) },
]) assert.throws(() => parseProviderEvent("payment", bad), ProviderEventError);

const raw = JSON.stringify(event);
const timestamp = Math.floor(Date.now() / 1000);
const header = signatureHeader(secret, raw, timestamp);
verifyProviderSignature(secret, raw, header);
assert.throws(() => verifyProviderSignature(secret, raw, header, Date.now() + 600_000), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, `${raw} `, header), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, raw, "t=1,v1=" + "0".repeat(64)), ProviderEventError);
assert.throws(() => verifyProviderSignature("too-short", raw, header), ProviderEventError);
assert.throws(() => verifyProviderSignature(secret, raw, null), ProviderEventError);

// Bounded raw-body reads: byte-accurate cap, early rejection, cancellation, exact HMAC bytes.
const LIMIT = 8 * 1024;

function countedBody(chunks, declaredLength) {
  const headers = new Headers();
  if (declaredLength !== undefined) headers.set("content-length", String(declaredLength));
  const state = { readerCalls: 0, readCalls: 0, cancelled: false };
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    cancel() { state.cancelled = true; },
  });
  const body = {
    getReader() {
      state.readerCalls++;
      const reader = stream.getReader();
      return {
        read() { state.readCalls++; return reader.read(); },
        cancel(reason) { return reader.cancel(reason); },
        releaseLock() { reader.releaseLock(); },
      };
    },
  };
  return { source: { headers, body }, state };
}

const exact = "é".repeat(LIMIT / 2);
const half = exact.length / 2;
const exactBody = countedBody([exact.slice(0, half), exact.slice(half)]);
const streamed = await readBoundedText(exactBody.source, LIMIT);
assert.equal(streamed, exact);
assert.equal(Buffer.byteLength(streamed, "utf8"), LIMIT);
verifyProviderSignature(secret, streamed, signatureHeader(secret, exact, timestamp));

const oversized = countedBody(["a".repeat(LIMIT), "b", "c".repeat(64)]);
await assert.rejects(
  () => readBoundedText(oversized.source, LIMIT, "Event payload is too large."),
  (error) => error instanceof BodyLimitError && error.status === 413 && error.message === "Event payload is too large.",
);
assert.equal(oversized.state.readCalls, 2, "must stop reading once the cap is crossed");
assert.equal(oversized.state.cancelled, true, "must cancel the stream on overflow");

const declared = countedBody(["x".repeat(LIMIT + 1)], LIMIT + 1);
await assert.rejects(() => readBoundedText(declared.source, LIMIT), BodyLimitError);
assert.equal(declared.state.readerCalls, 0, "must reject oversized content-length before reading");

const multibyte = countedBody(["é".repeat(LIMIT / 2 + 1)]);
await assert.rejects(() => readBoundedText(multibyte.source, LIMIT), BodyLimitError);

console.log("PASS: provider event validation, raw-body HMAC, and bounded body reads");
