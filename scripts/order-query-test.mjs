import assert from "node:assert/strict";
import {
  buildOrderQuery,
  matchesOrderStatus,
  orderParams,
  orderQueryKey,
  ORDER_FILTERS,
} from "../src/lib/order-query.ts";

// Each tab is a distinct cache key: switching must never reuse another tab's rows.
const keys = ORDER_FILTERS.map((filter) => orderQueryKey(buildOrderQuery("orders", filter, 1, "", "", "")));
assert.equal(new Set(keys).size, ORDER_FILTERS.length, "every order tab has a unique cache key");
assert.equal(orderQueryKey(buildOrderQuery("orders", "active", 1, "", "", "")), "active|1|||");

// Page, search and dates are part of the key, so pagination/filters stay isolated.
assert.notEqual(
  orderQueryKey(buildOrderQuery("orders", "active", 1, "", "", "")),
  orderQueryKey(buildOrderQuery("orders", "active", 2, "", "", "")),
);
assert.notEqual(
  orderQueryKey(buildOrderQuery("orders", "all", 1, "42", "", "")),
  orderQueryKey(buildOrderQuery("orders", "all", 1, "", "", "")),
);
assert.notEqual(
  orderQueryKey(buildOrderQuery("orders", "all", 1, "", "2026-11-01", "")),
  orderQueryKey(buildOrderQuery("orders", "all", 1, "", "", "2026-11-01")),
);

// Off the Orders page the book is always the active queue, regardless of the
// last filter used there — so Home and other pages never show stale tab rows.
assert.deepEqual(buildOrderQuery("home", "completed", 4, "99", "2026-11-01", "2026-11-07"), {
  status: "active", page: 1, search: "", from: "", to: "",
});
assert.deepEqual(buildOrderQuery("orders", "completed", 0, "99", "2026-11-01", "2026-11-07"), {
  status: "completed", page: 1, search: "99", from: "2026-11-01", to: "2026-11-07",
});

const params = orderParams(buildOrderQuery("orders", "ready", 2, " 42 ", "2026-11-01", "2026-11-07"));
assert.deepEqual(Object.fromEntries(params), {
  status: "ready", page: "2", limit: "20", search: " 42 ", from: "2026-11-01", to: "2026-11-07",
});
assert.deepEqual(Object.fromEntries(orderParams(buildOrderQuery("orders", "all", 1, "", "", ""))), {
  status: "all", page: "1", limit: "20",
});

const order = (status, feedbackAt = null) => ({ status, feedbackAt });
assert.ok(matchesOrderStatus(order("new"), "active"));
assert.ok(matchesOrderStatus(order("out_for_delivery"), "active"));
assert.ok(!matchesOrderStatus(order("completed"), "active"));
assert.ok(matchesOrderStatus(order("cancelled"), "cancelled"));
assert.ok(matchesOrderStatus(order("rejected"), "cancelled"));
assert.ok(matchesOrderStatus(order("completed", "2026-11-19T10:00:00Z"), "feedback"));
assert.ok(!matchesOrderStatus(order("completed"), "feedback"));
assert.ok(matchesOrderStatus(order("anything"), "all"));
assert.ok(matchesOrderStatus(order("preparing"), "preparing"));

// An optimistic status change must leave the old tab and enter the new one.
const accepted = order("accepted");
assert.ok(matchesOrderStatus(accepted, "active"));
assert.ok(!matchesOrderStatus(accepted, "completed"));
const completed = order("completed");
assert.ok(!matchesOrderStatus(completed, "active"));
assert.ok(matchesOrderStatus(completed, "completed"));

console.log("PASS: order tab query keys and cache status checks");
