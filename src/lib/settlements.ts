import "server-only";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { businessMarketplaceLinks, settlements } from "@/db/schema";
import { marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError } from "@/lib/server";
import { parseSettlementPayload, SettlementPayloadError } from "@/lib/settlement-payload";
import { log, logError } from "@/lib/telemetry";

const DEFAULT_MIN_INTERVAL_MS = 60_000;

export type SettlementSyncResult = {
  received: number;
  applied: number;
  skipped: number;
  throttled: boolean;
  lastSyncedAt: Date | null;
};

/** Mirror authoritative Marketplace payouts locally. Replays and stale feeds cannot duplicate or reverse rows. */
export async function syncMarketplaceSettlements(businessId: string, options: { force?: boolean; minIntervalMs?: number } = {}): Promise<SettlementSyncResult> {
  const [link] = await db.select().from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
  if (!link) throw new ApiError("Connect this business to your Marketplace listing first.", 409);

  const now = new Date();
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (!options.force && link.settlementSyncAttemptedAt && now.getTime() - link.settlementSyncAttemptedAt.getTime() < minInterval) {
    return { received: 0, applied: 0, skipped: 0, throttled: true, lastSyncedAt: link.settlementsSyncedAt };
  }

  await db.update(businessMarketplaceLinks)
    .set({ settlementSyncAttemptedAt: now })
    .where(eq(businessMarketplaceLinks.id, link.id));

  let payload: unknown;
  try {
    payload = await marketplaceFetch(businessId, "/api/integration/merchant/settlements", { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    logError("settlement.fetch_failed", error);
    throw error;
  }

  let rows;
  try {
    rows = parseSettlementPayload(payload);
  } catch (error) {
    logError("settlement.invalid_payload", error);
    throw new ApiError(error instanceof SettlementPayloadError ? error.message : "Marketplace returned invalid settlement records.", 502);
  }

  const syncedAt = new Date();
  const applied = await db.transaction(async (tx) => {
    let count = 0;
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

  log("settlement.sync_success", { received: rows.length, applied, skipped: rows.length - applied });
  return { received: rows.length, applied, skipped: rows.length - applied, throttled: false, lastSyncedAt: syncedAt };
}
