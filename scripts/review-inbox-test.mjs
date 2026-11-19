import assert from "node:assert/strict";
import { parseRemoteFeedbackInbox } from "../src/lib/marketplace-payload.ts";
import { localReviewThemes } from "../src/lib/review-themes.ts";

const inbox = {
  ok: true,
  summary: { available: true, windowDays: 30, averageRating: 4, reviewCount: 1, badOrders: 0, pendingReplies: 1 },
  themes: [{ key: "delivery", label: "Delivery", count: 1, averageRating: 4 }],
  reviews: [{
    orderCode: "CRV-AB123",
    rating: 4,
    review: "Tasty food but delivery was late",
    feedbackAt: "2026-11-18T10:00:00.000Z",
    merchantResponse: "",
    merchantRespondedAt: null,
  }],
};

const parsed = parseRemoteFeedbackInbox(inbox);
assert.equal(parsed.reviews.length, 1);
assert.equal(parsed.reviews[0].orderCode, "CRV-AB123");
assert.equal(parsed.summary.pendingReplies, 1);
assert.equal(parsed.themes[0].key, "delivery");

assert.throws(() => parseRemoteFeedbackInbox({ ...inbox, ok: false }), /Marketplace review request failed/);
assert.throws(() => parseRemoteFeedbackInbox({ ...inbox, reviews: [{ ...inbox.reviews[0], rating: 7 }] }), /review rating/);
assert.throws(() => parseRemoteFeedbackInbox({ ...inbox, themes: [{ ...inbox.themes[0], key: "BAD KEY" }] }), /theme key/);
assert.throws(() => parseRemoteFeedbackInbox({ ...inbox, summary: null }), /feedback summary/);

// Local/demo themes mirror Marketplace buckets; paired themes are never derived here.
const now = new Date("2026-11-19T12:00:00.000Z");
const themes = localReviewThemes([
  { review: "Cold food and a late rider", rating: 2, feedbackAt: now.toISOString() },
  { review: "Great taste and fresh food", rating: 5, feedbackAt: now.toISOString() },
  { review: "Leaked box", rating: 1, feedbackAt: new Date("2026-10-01T00:00:00.000Z").toISOString() },
], now);
assert.deepEqual(themes, [
  { key: "food", label: "Food quality", count: 2, averageRating: 3.5 },
  { key: "delivery", label: "Delivery", count: 1, averageRating: 2 },
]);

console.log("PASS: review inbox parser and local themes are strict and deterministic");
