/**
 * Canonical identity for matching Marketplace orders to mirrored settlements.
 *
 * Paired order codes are alphanumeric, while a settlement's `orderNumber` is an integer.
 * The Marketplace order id/code must win whenever it is present; the numeric local order
 * number is only a fallback for unpaired outlets and legacy records.
 */

export type OrderIdentity = {
  marketplaceOrderId?: string | null;
  orderNumber?: string | number | null;
  externalId?: string | null;
};

function identityPart(value: string | number | null | undefined): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function canonicalOrderKey(row: OrderIdentity): string | null {
  return identityPart(row.marketplaceOrderId) ?? identityPart(row.orderNumber);
}

export function canonicalOrderDisplay(row: OrderIdentity): string {
  const marketplaceOrderId = identityPart(row.marketplaceOrderId);
  if (marketplaceOrderId) return marketplaceOrderId;
  const orderNumber = identityPart(row.orderNumber);
  if (orderNumber) return `SV-${orderNumber}`;
  return identityPart(row.externalId) ?? "";
}
