import "server-only";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { businessMarketplaceLinks, settlements } from "@/db/schema";
import { marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError } from "@/lib/server";
import { MAX_SETTLEMENTS, parseSettlementPage, SettlementPayloadError, type ParsedSettlement } from "@/lib/settlement-payload";
import { log, logError } from "@/lib/telemetry";

const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** 10 pages × 200 rows keeps a manual sync bounded without silently dropping newer payouts. */
const MAX_PAGES = 10;
const inFlight = new Map<string, Promise<SettlementSyncResult>>();

export type SettlementSyncResult = {
  received: number;
  applied: number;
  skipped: number;
  throttled: boolean;
  truncated: boolean;
  lastSyncedAt: Date | null;
};

function mergePage(all: Map<string, ParsedSettlement>, rows: ParsedSettlement[]) {
  for (const row of rows) {
    const current = all.get(row.marketplaceOrderId);
    if (!current || row.updatedAt > current.updatedAt) all.set(row.marketplaceOrderId, row);
  }
}

async function runSync(businessId: string, options: { force?: boolean; minIntervalMs?: number } = {}): Promise<SettlementSyncResult> {
  const [link] = await db.select().from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
  if (!link) throw new ApiError("Connect this business to your Marketplace listing first.", 409);

  const now = new Date();
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // `settlementSyncAttemptedAt` is written only after a complete, valid fetch.
  // A failed attempt must never consume the next retry window.
  if (!options.force && link.settlementSyncAttemptedAt && now.getTime() - link.settlementSyncAttemptedAt.getTime() < minInterval) {
    return { received: 0, applied: 0, skipped: 0, throttled: true, truncated: false, lastSyncedAt: link.settlementsSyncedAt };
  }

  const all = new Map<string, ParsedSettlement>();
  let page = 1;
  let hasMore = false;
  let truncated = false;
  do {
    let payload: unknown;
    try {
      payload = await marketplaceFetch(businessId, `/api/integration/merchant/settlements?page=${page}`, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      logError("settlement.fetch_failed", error, { page });
      throw error;
    }

    try {
      const parsed = parseSettlementPage(payload);
      if (parsed.page !== page) throw new SettlementPayloadError("Settlement page number does not match the request.");
      mergePage(all, parsed.rows);
      hasMore = parsed.hasMore;
    } catch (error) {
      logError("settlement.invalid_payload", error, { page });
      throw new ApiError(error instanceof SettlementPayloadError ? error.message : "Marketplace returned invalid settlement records.", 502);
    }

    page += 1;
    if (hasMore && page > MAX_PAGES) {
      truncated = true;
      log("settlement.page_limit_reached", { businessId, pages: MAX_PAGES });
      break;
    }
  } while (hasMore);

  const rows = [...all.values()];
  const syncedAt = new Date();
  const applied = await db.transaction(async (tx) => {
    let count = 0;
    // Re-read the link inside the transaction so a successful sync stamps both fields together.
    for (const row of rows) {
      const sourceUpdatedAt = new Date(row.updatedAt);
      const result = await tx.insert(settlements).values({
        businessId,
        externalId: row.externalId,
        marketplaceOrderId: row.marketplaceOrderId,
        orderNumber: row.orderNumber,
        netAmount: row.netPaise,
        grossAmount: row.grossPaise,
        commissionAmount: row.commissionPaise,
        refundAmount: row.refundPaise,
        adjustmentAmount: row.adjustmentPaise,
        currency: row.currency,
        status: row.status,
        reference: row.reference,
        paidAt: row.paidAt ? new Date(row.paidAt) : null,
        sourceUpdatedAt,
      }).onConflictDoUpdate({
        target: [settlements.businessId, settlements.marketplaceOrderId],
        set: {
          externalId: row.externalId,
          orderNumber: row.orderNumber,
          netAmount: row.netPaise,
          grossAmount: row.grossPaise,
          commissionAmount: row.commissionPaise,
          refundAmount: row.refundPaise,
          adjustmentAmount: row.adjustmentPaise,
          currency: row.currency,
          status: row.status,
          reference: row.reference,
          paidAt: row.paidAt ? new Date(row.paidAt) : null,
          sourceUpdatedAt,
        },
        where: sql`${settlements.sourceUpdatedAt} is null or ${settlements.sourceUpdatedAt} < ${sourceUpdatedAt}`,
      }).returning({ id: settlements.id });
      if (result.length) count++;
    }
    await tx.update(businessMarketplaceLinks)
      .set({ settlementSyncAttemptedAt: syncedAt, settlementsSyncedAt: syncedAt })
      .where(eq(businessMarketplaceLinks.id, link.id));
    return count;
  });

  log("settlement.sync_success", { received: rows.length, applied, skipped: rows.length - applied, pages: page - 1, truncated });
  return { received: rows.length, applied, skipped: rows.length - applied, throttled: false, truncated, lastSyncedAt: syncedAt };
}

/** Mirror authoritative Marketplace payouts locally. Replays and stale feeds cannot duplicate or reverse rows. */
export async function syncMarketplaceSettlements(businessId: string, options: { force?: boolean; minIntervalMs?: number } = {}): Promise<SettlementSyncResult> {
  const existing = inFlight.get(businessId);
  if (existing) return existing;
  const task = runSync(businessId, options).finally(() => { inFlight.delete(businessId); });
  inFlight.set(businessId, task);
  return task;
}

export { MAX_SETTLEMENTS, MAX_PAGES };
