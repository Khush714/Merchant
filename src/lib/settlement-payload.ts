/**
 * Pure validation for the authoritative settlement feed. Kept free of server-only imports so the
 * same rules can be exercised directly in tests; the sync service turns failures into API errors.
 */

export type SettlementStatus = "pending" | "paid" | "failed" | "reversed";

export type ParsedSettlement = {
  externalId: string;
  marketplaceOrderId: string;
  orderNumber: number;
  grossPaise: number;
  commissionPaise: number;
  refundPaise: number;
  adjustmentPaise: number;
  netPaise: number;
  currency: string;
  status: SettlementStatus;
  reference: string;
  paidAt: string | null;
  updatedAt: string;
};

export const MAX_SETTLEMENTS = 200;
const MAX_PAISE = 2_147_483_647;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const STATUSES: readonly SettlementStatus[] = ["pending", "paid", "failed", "reversed"];

export class SettlementPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementPayloadError";
  }
}

function fail(message: string): never {
  throw new SettlementPayloadError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length > max) fail(`${label} is invalid.`);
  if (pattern && !pattern.test(value)) fail(`${label} is invalid.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label} contains control characters.`);
  return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string, required = true): string | null {
  if (value === null && !required) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function status(value: unknown): SettlementStatus {
  if (typeof value !== "string" || !STATUSES.includes(value as SettlementStatus)) fail("Settlement status is invalid.");
  return value as SettlementStatus;
}

export function parseSettlementPayload(payload: unknown): ParsedSettlement[] {
  const root = record(payload, "Settlement payload");
  if (!Array.isArray(root.settlements)) fail("Settlement payload is missing its records.");
  if (root.settlements.length > MAX_SETTLEMENTS) fail("Settlement payload contains too many records.");

  const rows = root.settlements.map((value, index) => {
    const label = `Settlement ${index + 1}`;
    const item = record(value, label);
    const externalId = text(item.externalId, `${label} externalId`, 128, ID_PATTERN);
    const marketplaceOrderId = text(item.marketplaceOrderId, `${label} marketplaceOrderId`, 128, ID_PATTERN);
    const orderNumber = integer(item.orderNumber, `${label} orderNumber`, 1, 2_147_483_647);
    const grossPaise = integer(item.grossPaise, `${label} grossPaise`, 0, MAX_PAISE);
    const commissionPaise = integer(item.commissionPaise, `${label} commissionPaise`, 0, MAX_PAISE);
    const refundPaise = integer(item.refundPaise, `${label} refundPaise`, 0, MAX_PAISE);
    const adjustmentPaise = integer(item.adjustmentPaise, `${label} adjustmentPaise`, -MAX_PAISE, MAX_PAISE);
    const netPaise = integer(item.netPaise, `${label} netPaise`, -MAX_PAISE, MAX_PAISE);
    if (grossPaise - commissionPaise - refundPaise + adjustmentPaise !== netPaise) {
      fail(`${label} net amount does not match its components.`);
    }
    const currency = text(item.currency, `${label} currency`, 3);
    if (currency !== "INR") fail(`${label} currency is unsupported.`);
    const settlementStatus = status(item.status);
    const reference = text(item.reference ?? "", `${label} reference`, 200);
    const paidAt = timestamp(item.paidAt, `${label} paidAt`, settlementStatus === "paid");
    const updatedAt = timestamp(item.updatedAt, `${label} updatedAt`)!;
    return { externalId, marketplaceOrderId, orderNumber, grossPaise, commissionPaise, refundPaise, adjustmentPaise, netPaise, currency, status: settlementStatus, reference, paidAt, updatedAt };
  });

  const orderIds = new Set<string>();
  const externalIds = new Set<string>();
  for (const row of rows) {
    if (orderIds.has(row.marketplaceOrderId)) fail("Settlement payload repeats a Marketplace order.");
    if (externalIds.has(row.externalId)) fail("Settlement payload repeats an external settlement id.");
    orderIds.add(row.marketplaceOrderId);
    externalIds.add(row.externalId);
  }
  return rows;
}

export type ParsedSettlementPage = {
  rows: ParsedSettlement[];
  page: number;
  hasMore: boolean;
};

/**
 * The authoritative feed is paginated so the 200-row validation boundary is a page
 * size, not a hard ceiling on mirrored history. Older responses without `hasMore`
 * remain valid single-page feeds.
 */
export function parseSettlementPage(payload: unknown): ParsedSettlementPage {
  const root = record(payload, "Settlement payload");
  if (root.hasMore !== undefined && typeof root.hasMore !== "boolean") fail("Settlement hasMore flag is invalid.");
  if (root.page !== undefined && (!Number.isSafeInteger(root.page) || (root.page as number) < 1)) fail("Settlement page is invalid.");
  const rows = parseSettlementPayload(payload);
  return {
    rows,
    page: (root.page as number | undefined) ?? 1,
    hasMore: root.hasMore === true && rows.length > 0,
  };
}
