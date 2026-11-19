/**
 * Pure local/demo item sales rollup.
 *
 * Paired workspaces never use this report: their item analytics are owned by
 * Marketplace. Unpaired and sample workspaces derive the same DTO from their own
 * immutable order lines so the UI does not need a second code path.
 */

import type { ItemAnalytics, ItemAnalyticsRow } from "./types";

export type ItemAnalyticsBounds = {
  from: string | null;
  to: string | null;
  fromDate: Date | null;
  toExclusiveDate: Date | null;
};

export type ItemAnalyticsSourceRow = {
  orderId: string;
  itemId: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  at: Date | string;
};

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function label(value: string): string {
  const clean = value.replace(control, "").trim().slice(0, 120);
  return clean || "Unnamed item";
}

export function localItemAnalytics(
  rows: readonly ItemAnalyticsSourceRow[],
  bounds: ItemAnalyticsBounds,
): ItemAnalytics {
  const buckets = new Map<string, { itemId: string | null; name: string; unitsSold: number; grossSales: number; orders: Set<string> }>();

  for (const row of rows) {
    const stamp = new Date(row.at).getTime();
    if (!Number.isFinite(stamp)) continue;
    if (bounds.fromDate && stamp < bounds.fromDate.getTime()) continue;
    if (bounds.toExclusiveDate && stamp >= bounds.toExclusiveDate.getTime()) continue;
    if (!Number.isFinite(row.quantity) || !Number.isFinite(row.unitPrice)) continue;
    const key = row.itemId ? `id:${row.itemId}` : `name:${label(row.name)}`;
    const bucket = buckets.get(key) ?? { itemId: row.itemId, name: label(row.name), unitsSold: 0, grossSales: 0, orders: new Set<string>() };
    bucket.unitsSold += Math.max(0, Math.trunc(row.quantity));
    bucket.grossSales += Math.max(0, Math.trunc(row.unitPrice * row.quantity));
    bucket.orders.add(row.orderId);
    buckets.set(key, bucket);
  }

  const items: ItemAnalyticsRow[] = [...buckets.values()]
    .map((bucket) => ({
      itemId: bucket.itemId,
      name: bucket.name,
      unitsSold: bucket.unitsSold,
      grossSales: bucket.grossSales,
      orders: bucket.orders.size,
    }))
    .sort((a, b) => b.grossSales - a.grossSales || a.name.localeCompare(b.name))
    .slice(0, 100);

  return {
    from: bounds.from,
    to: bounds.to,
    items,
    unitsSold: items.reduce((sum, row) => sum + row.unitsSold, 0),
    grossSales: items.reduce((sum, row) => sum + row.grossSales, 0),
    itemsSold: items.length,
    currency: "INR",
  };
}
