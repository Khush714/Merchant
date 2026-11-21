import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  paymentAttempts, payoutAllocations, payouts, reconciliationExceptions, reconciliationRuns,
  settlementLines, settlements, orders,
} from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse, parseRemoteOrders } from "@/lib/marketplace-bridge";
import {
  classifyReconciliation,
  type ReconciliationAttempt, type ReconciliationOrder, type ReconciliationPayout, type ReconciliationSettlement,
} from "@/lib/reconciliation-core";
import { ensureSettlementLines } from "@/lib/settlement-lines";
import { ApiError } from "@/lib/server";
import type { ReconciliationExceptionRecord, ReconciliationReportDto, ReconciliationRunRecord } from "@/lib/types";

const MAX_ORDERS = 2_000;
const MAX_EXCEPTIONS = 500;

function runDto(row: typeof reconciliationRuns.$inferSelect): ReconciliationRunRecord {
  return {
    id: row.id, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status, orderCount: row.orderCount, paymentCount: row.paymentCount,
    settlementCount: row.settlementCount, payoutCount: row.payoutCount, exceptionCount: row.exceptionCount,
  };
}

function exceptionDto(row: typeof reconciliationExceptions.$inferSelect, orderNumber: string | null): ReconciliationExceptionRecord {
  return {
    id: row.id, kind: row.kind, severity: row.severity, status: row.status,
    detail: row.detail, expectedPaise: row.expectedPaise, actualPaise: row.actualPaise,
    orderNumber, createdAt: row.createdAt.toISOString(),
  };
}

async function reportFor(businessId: string, notice: string, run: typeof reconciliationRuns.$inferSelect | null, exceptions: {
  row: typeof reconciliationExceptions.$inferSelect; orderNumber: string | null;
}[]): Promise<ReconciliationReportDto> {
  const counts: Record<string, number> = {};
  for (const { row } of exceptions) if (row.status === "open") counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return {
    available: true, notice,
    latestRun: run ? runDto(run) : null,
    exceptions: exceptions.map(({ row, orderNumber }) => exceptionDto(row, orderNumber)),
    counts,
    summary: {
      matchedSettlements: run ? Number((run.detail as Record<string, unknown>).matchedSettlements ?? 0) : 0,
      allocatedSettlements: run ? Number((run.detail as Record<string, unknown>).allocatedSettlements ?? 0) : 0,
      openExceptions: exceptions.filter(({ row }) => row.status === "open").length,
    },
  };
}

export async function getReconciliationReport(businessId: string): Promise<ReconciliationReportDto> {
  const [run] = await db.select().from(reconciliationRuns)
    .where(eq(reconciliationRuns.businessId, businessId))
    .orderBy(desc(reconciliationRuns.startedAt)).limit(1);
  if (!run) {
    return reportFor(businessId, "No reconciliation has run yet. Run one to compare orders, collections and payouts.", null, []);
  }
  const rows = await db.select({ row: reconciliationExceptions, orderNumber: orders.orderNumber })
    .from(reconciliationExceptions)
    .leftJoin(orders, eq(reconciliationExceptions.orderId, orders.id))
    .where(and(eq(reconciliationExceptions.businessId, businessId), eq(reconciliationExceptions.runId, run.id)))
    .orderBy(reconciliationExceptions.createdAt).limit(MAX_EXCEPTIONS);
  return reportFor(businessId, "", run, rows.map(({ row, orderNumber }) => ({
    row, orderNumber: orderNumber === null ? null : String(orderNumber),
  })));
}

/** Run an explicit reconciliation for the active outlet and persist a typed exception ledger. */
export async function runReconciliation(businessId: string, actorId: string): Promise<ReconciliationReportDto> {
  await ensureSettlementLines(businessId);
  const link = await getMarketplaceLink(businessId);
  let orderRows: ReconciliationOrder[];
  if (link) {
    orderRows = [];
    for (let page = 1; page <= 20; page++) {
      const remote = await marketplaceFetch(businessId, `/api/integration/merchant/orders?status=all&page=${page}&limit=50`, { signal: AbortSignal.timeout(10_000) });
      const parsed = parseMarketplaceResponse(remote, (payload) => parseRemoteOrders(payload, businessId));
      for (const order of parsed.orders) {
        orderRows.push({
          key: String(order.orderNumber), id: null, totalPaise: order.total,
          paymentStatus: order.paymentStatus, status: order.status,
        });
      }
      if (!parsed.hasMore || orderRows.length >= MAX_ORDERS) break;
    }
  } else {
    const rows = await db.select().from(orders).where(eq(orders.businessId, businessId)).orderBy(orders.createdAt).limit(MAX_ORDERS);
    orderRows = rows.map((row) => ({
      key: String(row.orderNumber), id: row.id, totalPaise: row.total,
      paymentStatus: row.paymentStatus, status: row.status, refundedPaise: row.refund ?? undefined,
    }));
  }

  const [attemptRows, settlementRows, payoutRows, allocationRows] = await Promise.all([
    db.select({ attempt: paymentAttempts, orderNumber: orders.orderNumber }).from(paymentAttempts)
      .innerJoin(orders, eq(paymentAttempts.orderId, orders.id))
      .where(eq(paymentAttempts.businessId, businessId)).limit(MAX_ORDERS),
    db.select({ line: settlementLines, marketplaceOrderId: settlements.marketplaceOrderId, orderNumber: settlements.orderNumber })
      .from(settlementLines).innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
      .where(eq(settlementLines.businessId, businessId)).limit(MAX_ORDERS),
    db.select().from(payouts).where(eq(payouts.businessId, businessId)).orderBy(payouts.createdAt).limit(500),
    db.select().from(payoutAllocations).where(eq(payoutAllocations.businessId, businessId)),
  ]);

  const attempts: ReconciliationAttempt[] = attemptRows.map(({ attempt, orderNumber }) => ({
    key: String(orderNumber), id: attempt.id, status: attempt.status, amountPaise: attempt.amountPaise,
  }));
  const settlementData: ReconciliationSettlement[] = settlementRows.map(({ line, marketplaceOrderId, orderNumber }) => ({
    key: String(orderNumber ?? marketplaceOrderId), id: line.settlementId, status: "settled",
    grossPaise: line.grossPaise, commissionPaise: line.commissionPaise,
    gatewayFeePaise: line.gatewayFeePaise, taxPaise: line.taxPaise,
    refundPaise: line.refundPaise, adjustmentPaise: line.adjustmentPaise, netPaise: line.netPaise,
  }));
  const allocationsByPayout = new Map<string, { settlementId: string; amountPaise: number }[]>();
  for (const row of allocationRows) {
    if (!row.settlementId) continue;
    const list = allocationsByPayout.get(row.payoutId) ?? [];
    list.push({ settlementId: row.settlementId, amountPaise: row.amountPaise });
    allocationsByPayout.set(row.payoutId, list);
  }
  const payoutData: ReconciliationPayout[] = payoutRows.map((row) => ({
    id: row.id, reference: row.reference, amountPaise: row.amountPaise, status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    allocations: allocationsByPayout.get(row.id) ?? [],
  }));

  const report = classifyReconciliation({
    orders: orderRows, attempts, settlements: settlementData, payouts: payoutData,
  });
  const detail = {
    matchedSettlements: report.matchedSettlements,
    allocatedSettlements: report.allocatedSettlements,
    source: link ? "marketplace_orders" : "local_orders",
    truncated: orderRows.length >= MAX_ORDERS || report.exceptions.length > MAX_EXCEPTIONS,
  };
  const result = await db.transaction(async (tx) => {
    const [run] = await tx.insert(reconciliationRuns).values({
      businessId, status: "running", triggeredBy: actorId, detail,
      orderCount: orderRows.length, paymentCount: attempts.length,
      settlementCount: settlementData.length, payoutCount: payoutData.length,
    }).returning();
    if (report.exceptions.length) {
      await tx.insert(reconciliationExceptions).values(report.exceptions.slice(0, MAX_EXCEPTIONS).map((item) => ({
        businessId, runId: run.id, kind: item.kind, severity: item.severity, detail: item.detail,
        expectedPaise: item.expectedPaise, actualPaise: item.actualPaise,
        orderId: item.orderId, paymentAttemptId: item.paymentAttemptId,
        settlementId: item.settlementId, payoutId: item.payoutId,
      })));
    }
    const [finished] = await tx.update(reconciliationRuns).set({
      status: "completed", finishedAt: new Date(), exceptionCount: report.exceptions.length, detail,
    }).where(eq(reconciliationRuns.id, run.id)).returning();
    return finished;
  });
  return getReconciliationReport(businessId).then((current) => ({ ...current, latestRun: runDto(result) }));
}

export async function resolveReconciliationException(businessId: string, actorId: string, input: {
  id: string; note: string;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) throw new ApiError("Exception not found.", 404);
  const note = typeof input.note === "string" ? input.note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
  if (!note) throw new ApiError("Add a resolution note.");
  const [row] = await db.update(reconciliationExceptions).set({
    status: "resolved", resolutionNote: note, resolvedBy: actorId, resolvedAt: new Date(),
  }).where(and(
    eq(reconciliationExceptions.id, input.id), eq(reconciliationExceptions.businessId, businessId),
    eq(reconciliationExceptions.status, "open"),
  )).returning();
  if (!row) throw new ApiError("Only an open exception can be resolved.", 409);
  return { id: row.id, status: row.status };
}

export { MAX_EXCEPTIONS };
