import "server-only";

import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, paymentAttempts, settlementLines, settlements } from "@/db/schema";
import type { DbQueryable, DbTransaction } from "@/lib/db-types";
import { feeScheduleFor } from "@/lib/fee-schedules";
import { ApiError } from "@/lib/server";
import {
  buildSettlementLineDrafts,
  legacySettlementLineValues,
  SETTLEMENT_LINE_VERSION,
  type SettlementLineDraft,
} from "@/lib/settlement-line-core";
import type { SettlementLinePage, SettlementLineRecord } from "@/lib/types";

export const DEFAULT_LINE_PAGE_SIZE = 200;
export const MAX_LINE_PAGE_SIZE = 500;
/** Every individual read/write stays inside this ceiling; explicit full rebuilds loop over batches. */
const PROCESSING_BATCH_SIZE = 200;

type LineCursor = { id: string };
type InsertLine = typeof settlementLines.$inferInsert;
type SettlementRow = typeof settlements.$inferSelect;

const lineInFlight = new Map<string, Promise<number>>();

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function lineDto(row: typeof settlementLines.$inferSelect, orderNumber: string): SettlementLineRecord {
  return {
    id: row.id, settlementId: row.settlementId, orderNumber,
    grossPaise: row.grossPaise, commissionPaise: row.commissionPaise,
    gatewayFeePaise: row.gatewayFeePaise, taxPaise: row.taxPaise,
    refundPaise: row.refundPaise, adjustmentPaise: row.adjustmentPaise,
    netPaise: row.netPaise, source: row.source, createdAt: row.createdAt.toISOString(),
    lineVersion: row.lineVersion, feeScheduleId: row.feeScheduleId,
    sourceUpdatedAt: iso(row.sourceUpdatedAt), rebuiltAt: iso(row.rebuiltAt),
    expectedNetPaise: row.expectedNetPaise, matchesAuthoritative: row.matchesAuthoritative,
  };
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push([...rows.slice(index, index + size)]);
  return result;
}

function toInsert(row: SettlementLineDraft): InsertLine {
  return {
    businessId: row.businessId,
    settlementId: row.settlementId,
    orderId: row.orderId,
    paymentAttemptId: row.paymentAttemptId,
    grossPaise: row.grossPaise,
    commissionPaise: row.commissionPaise,
    gatewayFeePaise: row.gatewayFeePaise,
    taxPaise: row.taxPaise,
    refundPaise: row.refundPaise,
    adjustmentPaise: row.adjustmentPaise,
    netPaise: row.netPaise,
    expectedNetPaise: row.expectedNetPaise,
    matchesAuthoritative: row.matchesAuthoritative,
    source: row.source,
    sourceAt: row.sourceAt,
    sourceUpdatedAt: row.sourceUpdatedAt,
    feeScheduleId: row.feeScheduleId,
    lineVersion: row.lineVersion,
    rebuiltAt: row.rebuiltAt,
  };
}

async function upsertLines(reader: DbQueryable, drafts: readonly SettlementLineDraft[]): Promise<void> {
  for (const batch of chunks(drafts, PROCESSING_BATCH_SIZE)) {
    await reader.insert(settlementLines).values(batch.map(toInsert)).onConflictDoUpdate({
      target: settlementLines.settlementId,
      set: {
        orderId: sql`excluded.order_id`,
        paymentAttemptId: sql`excluded.payment_attempt_id`,
        grossPaise: sql`excluded.gross_paise`,
        commissionPaise: sql`excluded.commission_paise`,
        gatewayFeePaise: sql`excluded.gateway_fee_paise`,
        taxPaise: sql`excluded.tax_paise`,
        refundPaise: sql`excluded.refund_paise`,
        adjustmentPaise: sql`excluded.adjustment_paise`,
        netPaise: sql`excluded.net_paise`,
        expectedNetPaise: sql`excluded.expected_net_paise`,
        matchesAuthoritative: sql`excluded.matches_authoritative`,
        source: sql`excluded.source`,
        sourceAt: sql`excluded.source_at`,
        sourceUpdatedAt: sql`excluded.source_updated_at`,
        feeScheduleId: sql`excluded.fee_schedule_id`,
        lineVersion: sql`excluded.line_version`,
        rebuiltAt: sql`excluded.rebuilt_at`,
      },
      // A stale rebuild cannot replace a line already derived from a newer feed version.
      // Equal versions are allowed so an explicit fee-schedule rebuild can refresh metadata.
      setWhere: sql`${settlementLines.sourceUpdatedAt} is null or (excluded.source_updated_at is not null and ${settlementLines.sourceUpdatedAt} <= excluded.source_updated_at)`,
    });
  }
}

/** Load only the settlement-linked orders/attempts needed by one bounded batch. */
async function draftsForBatch(
  tx: DbTransaction,
  businessId: string,
  rows: readonly SettlementRow[],
  schedule: Awaited<ReturnType<typeof feeScheduleFor>>["values"],
  feeScheduleId: string | null,
  rebuiltAt: Date,
): Promise<SettlementLineDraft[]> {
  const orderNumbers = [...new Set(rows.map((row) => row.orderNumber).filter((value): value is number => value !== null))];
  const orderRows = orderNumbers.length
    ? await tx.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders)
      .where(and(eq(orders.businessId, businessId), inArray(orders.orderNumber, orderNumbers)))
      .orderBy(asc(orders.orderNumber), asc(orders.id))
    : [];
  const orderIds = [...new Set(orderRows.map((row) => row.id))];
  const attemptRows = orderIds.length
    ? await tx.select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId, createdAt: paymentAttempts.createdAt })
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.businessId, businessId), inArray(paymentAttempts.orderId, orderIds)))
      .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id))
    : [];
  return buildSettlementLineDrafts({
    businessId, settlements: rows, orders: orderRows, attempts: attemptRows,
    schedule, feeScheduleId, rebuiltAt,
  });
}

/**
 * Legacy full rebuild, retained verbatim as the reconciliation reference implementation.
 * Production reads no longer call it; the explicit sync path uses incremental maintenance.
 */
export async function rebuildSettlementLinesLegacy(businessId: string): Promise<number> {
  const [{ values: schedule }, settlementRows, orderRows, attemptRows] = await Promise.all([
    feeScheduleFor(businessId),
    db.select().from(settlements).where(eq(settlements.businessId, businessId)),
    db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.businessId, businessId)),
    db.select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId, createdAt: paymentAttempts.createdAt })
      .from(paymentAttempts).where(eq(paymentAttempts.businessId, businessId))
      .orderBy(asc(paymentAttempts.createdAt), asc(paymentAttempts.id)),
  ]);
  const rebuiltAt = new Date();
  const drafts: SettlementLineDraft[] = legacySettlementLineValues({
    businessId, settlements: settlementRows, orders: orderRows, attempts: attemptRows, schedule,
  }).map((line) => ({
    ...line,
    businessId,
    feeScheduleId: null,
    lineVersion: "legacy",
    rebuiltAt,
  }));
  await upsertLines(db, drafts);
  return drafts.length;
}

/** Backwards-compatible explicit reference export. Never call this from a read path. */
export const ensureSettlementLines = rebuildSettlementLinesLegacy;

/**
 * Rebuild only the settlements named by `settlementIds`. `full` is an explicit repair or
 * fee-schedule change and is still requested deliberately. Every query is bounded and a
 * transaction-scoped advisory lock serialises concurrent processors across instances.
 */
export async function maintainSettlementLinesInTx(
  tx: DbTransaction,
  businessId: string,
  options: { settlementIds?: string[]; includeMissing?: boolean; full?: boolean } = {},
): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${businessId}, 0))`);
  const { values: schedule, dto: scheduleDto } = await feeScheduleFor(businessId, tx);
  const rebuiltAt = new Date();
  const businessFilter = eq(settlements.businessId, businessId);

  if (options.full) {
    let cursor: string | null = null;
    let maintained = 0;
    for (;;) {
      const filters = [businessFilter];
      if (cursor) filters.push(gt(settlements.id, cursor));
      const rows = await tx.select().from(settlements)
        .where(and(...filters))
        .orderBy(asc(settlements.id))
        .limit(PROCESSING_BATCH_SIZE);
      if (!rows.length) break;
      const drafts = await draftsForBatch(tx, businessId, rows, schedule, scheduleDto.id, rebuiltAt);
      await upsertLines(tx, drafts);
      maintained += drafts.length;
      cursor = rows[rows.length - 1].id;
      if (rows.length < PROCESSING_BATCH_SIZE) break;
    }
    return maintained;
  }

  const ids = [...new Set(options.settlementIds ?? [])];
  if (options.includeMissing) {
    let cursor: string | null = null;
    for (;;) {
      const stale = or(
        isNull(settlementLines.id),
        ne(settlementLines.lineVersion, SETTLEMENT_LINE_VERSION),
        sql`${settlementLines.feeScheduleId} is distinct from ${scheduleDto.id}`,
        sql`${settlementLines.sourceUpdatedAt} is null and ${settlements.sourceUpdatedAt} is not null`,
        sql`${settlementLines.sourceUpdatedAt} < ${settlements.sourceUpdatedAt}`,
      );
      const filters = [eq(settlements.businessId, businessId), stale];
      if (cursor) filters.push(gt(settlements.id, cursor));
      const rows = await tx.select({ id: settlements.id })
        .from(settlements)
        .leftJoin(settlementLines, eq(settlementLines.settlementId, settlements.id))
        .where(and(...filters))
        .orderBy(asc(settlements.id))
        .limit(PROCESSING_BATCH_SIZE);
      if (!rows.length) break;
      ids.push(...rows.map((row) => row.id));
      cursor = rows[rows.length - 1].id;
      if (rows.length < PROCESSING_BATCH_SIZE) break;
    }
  }

  if (!ids.length) return 0;
  let maintained = 0;
  for (const batch of chunks(ids, PROCESSING_BATCH_SIZE)) {
    const rows = await tx.select().from(settlements)
      .where(and(businessFilter, inArray(settlements.id, batch)));
    const drafts = await draftsForBatch(tx, businessId, rows, schedule, scheduleDto.id, rebuiltAt);
    await upsertLines(tx, drafts);
    maintained += drafts.length;
  }
  return maintained;
}

/** Explicit incremental maintenance with process-local dedupe plus the database advisory lock. */
export async function maintainSettlementLines(
  businessId: string,
  options: { settlementIds?: string[]; includeMissing?: boolean; full?: boolean } = {},
): Promise<number> {
  if (!options.full && !options.settlementIds?.length && !options.includeMissing) return 0;
  const existing = lineInFlight.get(businessId);
  if (existing) return existing;
  const task = db.transaction(async (tx) => maintainSettlementLinesInTx(tx, businessId, options))
    .finally(() => { if (lineInFlight.get(businessId) === task) lineInFlight.delete(businessId); });
  lineInFlight.set(businessId, task);
  return task;
}

/** UUID-only cursor: stable across rebuilds and immune to timestamp precision loss. */
export function encodeLineCursor(cursor: LineCursor): string {
  return Buffer.from(JSON.stringify({ id: cursor.id }), "utf8").toString("base64url");
}

export function decodeLineCursor(value: string): LineCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { id?: unknown };
    if (typeof parsed.id !== "string" || !parsed.id) throw new Error("invalid cursor");
    return { id: parsed.id };
  } catch {
    throw new ApiError("Invalid settlement-line cursor.", 400);
  }
}

/** Read-only, keyset-paginated settlement-line list. Never mutates derived data. */
export async function listSettlementLines(
  businessId: string,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<SettlementLinePage> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LINE_PAGE_SIZE, 1), MAX_LINE_PAGE_SIZE);
  const cursor = options.cursor ? decodeLineCursor(options.cursor) : null;
  const cursorFilter = cursor ? gt(settlementLines.id, cursor.id) : undefined;
  const filter = cursorFilter
    ? and(eq(settlementLines.businessId, businessId), cursorFilter)
    : eq(settlementLines.businessId, businessId);

  const [countRow, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(settlementLines)
      .where(eq(settlementLines.businessId, businessId)),
    db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
      .from(settlementLines)
      .innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
      .where(filter)
      .orderBy(asc(settlementLines.id))
      .limit(limit + 1),
  ]);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    lines: pageRows.map(({ line, orderNumber }) => lineDto(line, String(orderNumber ?? ""))),
    count: countRow[0]?.count ?? 0,
    hasMore,
    nextCursor: hasMore && last ? encodeLineCursor({ id: last.line.id }) : null,
  };
}
