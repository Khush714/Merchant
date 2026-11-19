import type { Order } from "@/lib/types";

/**
 * Pure order-book query helpers shared by the merchant UI and its tests.
 * Keeping tab switching keyed by these values lets the UI serve cached results
 * synchronously and revalidate in the background, instead of waiting on a poll.
 */

export type OrderQuery = { status: string; page: number; search: string; from: string; to: string };
export type CachedOrders = { orders: Order[]; hasMore: boolean };

export const ORDER_FILTERS = ["active", "new", "accepted", "preparing", "ready", "out_for_delivery", "completed", "feedback", "cancelled", "all"] as const;

export function buildOrderQuery(page: string, filter: string, orderPage: number, search: string, from: string, to: string): OrderQuery {
  const onOrders = page === "orders";
  return {
    status: onOrders ? filter : "active",
    page: onOrders ? Math.max(1, orderPage) : 1,
    search: onOrders ? search : "",
    from: onOrders ? from : "",
    to: onOrders ? to : "",
  };
}

export function orderQueryKey(query: OrderQuery): string {
  return `${query.status}|${query.page}|${query.search}|${query.from}|${query.to}`;
}

export function orderParams(query: OrderQuery): URLSearchParams {
  const params = new URLSearchParams({ status: query.status, page: String(query.page), limit: "20" });
  if (query.search) params.set("search", query.search);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return params;
}

/** Mirrors the server's status filters, so a cached tab drops rows that moved on. */
export function matchesOrderStatus(order: Order, status: string): boolean {
  if (status === "all") return true;
  if (status === "active") return ["new", "accepted", "preparing", "ready", "out_for_delivery"].includes(order.status);
  if (status === "cancelled") return ["rejected", "cancelled"].includes(order.status);
  if (status === "feedback") return !!order.feedbackAt;
  return order.status === status;
}
