import "server-only";

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { businessMarketplaceLinks, settlements } from "@/db/schema";
import { marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError } from "@/lib/server";
import { maintainSettlementLinesInTx } from "@/lib/settlement-lines";
import { MAX_SETTLEMENTS, parseSettlementPage, SettlementPayloadError, type ParsedSettlement } from "@/lib/settlement-payload";
import { log, logError } from "@/lib/telemetry";

const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** 10 pages × 200 rows keeps a manual sync bounded without silently dropping newer payouts. */
const MAX_PAGES = 10;
/** 250 rows × 14 bound parameters ≈ 3,500, well below PostgreSQL's 65,535 bind-parameter limit. */
export const SETTLEMENT_UPSERT_BATCH_SIZE = 250;
const inFlight = new Map<string, Promise<SettlementSyncResult>>();

export type SettlementSyncResult = {
  received: number;
  applied: number;
  skipped: number;
  throttled: boolean;
  truncated: boolean;
  lineCount: number;
  lastSyncedAt: Date | null;
};

function mergePage(all: Map<string, ParsedSettlement>, rows: ParsedSettlement[]) {
  for (const row of rows) {
    const current = all.get(row.marketplaceOrderId);
    // Equal timestamps keep the first page's record, so page order is the tie-breaker.
    if (!current || row.updatedAt > current.updatedAt) all.set(row.marketplaceOrderId, row);
  }
}

/** A repeated external id with a different order id must not abort the whole batch. */
function dedupeByExternalId(rows: readonly ParsedSettlement[]): ParsedSettlement[] {
  const byExternal = new Map<string, ParsedSettlement>();
  for (const row of rows) {
    const current = byExternal.get(row.externalId);
    // Equal timestamps resolve to the lexicographically smaller order id, independent of page order.
    if (!current || row.updatedAt > current.updatedAt
      || (row.updatedAt === current.updatedAt && row.marketplaceOrderId.localeCompare(current.marketplaceOrderId) < 0)) {
      byExternal.set(row.externalId, row);
    }
  }
  return [...byExternal.values()];
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push([...rows.slice(index, index + size)]);
  return result;
}

function settlementValues(businessId: string, row: ParsedSettlement) {
  return {
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
    sourceUpdatedAt: new Date(row.updatedAt),
  };
}

async function runSync(businessId: string, options: { force?: boolean; minIntervalMs?: number } = {}): Promise<SettlementSyncResult> {
  const [link] = await db.select().from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
  if (!link) throw new ApiError("Connect this business to your Marketplace listing first.", 409);

  const now = new Date();
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // `settlementSyncAttemptedAt` is written only after a complete, valid fetch.
  // A failed attempt must never consume the next retry window.
  if (!options.force && link.settlementSyncAttemptedAt && now.getTime() - link.settlementSyncAttemptedAt.getTime() < minInterval) {
    return { received: 0, applied: 0, skipped: 0, throttled: true, truncated: false, lineCount: 0, lastSyncedAt: link.settlementsSyncedAt };
  }
  log("settlement.sync_start", { businessId, force: Boolean(options.force) });

  const all = new Map<string, ParsedSettlement>();
  let page = 1;
  let hasMore = false;
  let truncated = false;
  do {
    let payload: unknown;
    try {
      payload = await marketplaceFetch(businessId, `/api/integration/merchant/settlements?page=${page}`, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      logError("settlement.fetch_failed", error, { businessId, page });
      throw error;
    }

    try {
      const parsed = parseSettlementPage(payload);
      if (parsed.page !== page) throw new SettlementPayloadError("Settlement page number does not match the request.");
      mergePage(all, parsed.rows);
      hasMore = parsed.hasMore;
    } catch (error) {
      logError("settlement.invalid_payload", error, { businessId, page });
      throw new ApiError(error instanceof SettlementPayloadError ? error.message : "Marketplace returned invalid settlement records.", 502);
    }

    page += 1;
    if (hasMore && page > MAX_PAGES) {
      truncated = true;
      log("settlement.page_limit_reached", { businessId, pages: MAX_PAGES });
      break;
    }
  } while (hasMore);

  const rows = dedupeByExternalId([...all.values()]);
  const syncedAt = new Date();
  let transactionResult: { applied: number; lineCount: number };
  try {
    transactionResult = await db.transaction(async (tx) => {
      // Distinct from the settlement-line lock salt (0). Serialises syncs across instances
      // while keeping all settlement, line and marker writes under one bounded transaction.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${businessId}, 1))`);
      let appliedCount = 0;

      // Batched upserts replace 2,000 sequential statements. The strict guard keeps
      // the persisted row on equal timestamps and blocks older source records entirely.
      for (const [batchIndex, batch] of chunks(rows, SETTLEMENT_UPSERT_BATCH_SIZE).entries()) {
        const written = await tx.insert(settlements).values(batch.map((row) => settlementValues(businessId, row)))
          .onConflictDoUpdate({
            target: [settlements.businessId, settlements.marketplaceOrderId],
            set: {
              externalId: sql`excluded.external_id`,
              orderNumber: sql`excluded.order_number`,
              netAmount: sql`excluded.amount`,
              grossAmount: sql`excluded.gross_amount`,
              commissionAmount: sql`excluded.commission_amount`,
              refundAmount: sql`excluded.refund_amount`,
              adjustmentAmount: sql`excluded.adjustment_amount`,
              currency: sql`excluded.currency`,
              status: sql`excluded.status`,
              reference: sql`excluded.reference`,
              paidAt: sql`excluded.paid_at`,
              sourceUpdatedAt: sql`excluded.source_updated_at`,
            },
            setWhere: sql`${settlements.sourceUpdatedAt} is null or ${settlements.sourceUpdatedAt} < excluded.source_updated_at`,
          }).returning({ id: settlements.id });
        appliedCount += written.length;
        log("settlement.sync_batch", { businessId, batch: batchIndex + 1, rows: batch.length, applied: written.length });
      }

      // Select touched ids after the upserts so stale and missing legacy rows are repaired too.
      const touchedIds: string[] = [];
      const orderIds = [...new Set(rows.map((row) => row.marketplaceOrderId))];
      for (const batch of chunks(orderIds, SETTLEMENT_UPSERT_BATCH_SIZE)) {
        const found = await tx.select({ id: settlements.id }).from(settlements)
          .where(and(eq(settlements.businessId, businessId), inArray(settlements.marketplaceOrderId, batch)));
        touchedIds.push(...found.map((row) => row.id));
      }
      const maintained = await maintainSettlementLinesInTx(tx, businessId, { settlementIds: touchedIds, includeMissing: true });

      // A slower, older snapshot must never move the sync markers backwards.
      await tx.update(businessMarketplaceLinks)
        .set({ settlementSyncAttemptedAt: syncedAt, settlementsSyncedAt: syncedAt })
        .where(and(
          eq(businessMarketplaceLinks.id, link.id),
          or(isNull(businessMarketplaceLinks.settlementSyncAttemptedAt), lte(businessMarketplaceLinks.settlementSyncAttemptedAt, syncedAt)),
        ));
      return { applied: appliedCount, lineCount: maintained };
    });
  } catch (error) {
    logError("settlement.write_failed", error, { businessId, rows: rows.length });
    throw error;
  }
  const { applied, lineCount } = transactionResult;

  log("settlement.sync_success", {
    businessId, received: rows.length, applied, lineCount, skipped: rows.length - applied, pages: page - 1, truncated,
  });
  return {
    received: rows.length, applied, skipped: rows.length - applied, throttled: false,
    truncated, lineCount, lastSyncedAt: syncedAt,
  };
}

/** Mirror authoritative Marketplace settlements locally. Replays and stale feeds cannot duplicate or reverse rows. */
export async function syncMarketplaceSettlements(businessId: string, options: { force?: boolean; minIntervalMs?: number } = {}): Promise<SettlementSyncResult> {
  // A forced retry must evaluate its own throttle bypass instead of joining a throttled GET sync.
  if (!options.force) {
    const existing = inFlight.get(businessId);
    if (existing) return existing;
  }
  let task: Promise<SettlementSyncResult>;
  task = runSync(businessId, options).finally(() => {
    if (inFlight.get(businessId) === task) inFlight.delete(businessId);
  });
  inFlight.set(businessId, task);
  return task;
}

export { MAX_SETTLEMENTS, MAX_PAGES };
