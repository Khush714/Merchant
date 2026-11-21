import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  payoutAllocations, settlementLines, settlementStatements, settlements,
} from "@/db/schema";
import { aggregateStatement } from "@/lib/fee-math";
import { listSettlementLines } from "@/lib/settlement-lines";
import { ApiError } from "@/lib/server";
import type { FinanceSummary, StatementDetail, StatementRecord } from "@/lib/types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function range(from: string, to: string) {
  if (!DATE.test(from) || !DATE.test(to)) throw new ApiError("Choose a valid from and to date.");
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new ApiError("Invalid statement period.");
  return { start, end };
}

function statementDto(row: typeof settlementStatements.$inferSelect): StatementRecord {
  return {
    id: row.id, number: row.number, periodFrom: row.periodFrom, periodTo: row.periodTo,
    grossPaise: row.grossPaise, commissionPaise: row.commissionPaise,
    gatewayFeePaise: row.gatewayFeePaise, taxPaise: row.taxPaise,
    refundPaise: row.refundPaise, adjustmentPaise: row.adjustmentPaise,
    netPaise: row.netPaise, lineCount: row.lineCount, status: row.status,
    checksum: row.checksum, createdAt: row.createdAt.toISOString(),
  };
}

export async function listStatements(businessId: string): Promise<StatementRecord[]> {
  const rows = await db.select().from(settlementStatements)
    .where(eq(settlementStatements.businessId, businessId))
    .orderBy(desc(settlementStatements.createdAt)).limit(100);
  return rows.map(statementDto);
}

export async function statementDetail(businessId: string, id: string): Promise<StatementDetail> {
  const [row] = await db.select().from(settlementStatements).where(and(
    eq(settlementStatements.id, id), eq(settlementStatements.businessId, businessId),
  )).limit(1);
  if (!row) throw new ApiError("Statement not found.", 404);
  const lines = await db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines).innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(eq(settlementLines.businessId, businessId)).orderBy(settlements.createdAt);
  const numberById = new Map(lines.map(({ line, orderNumber }) => [line.settlementId, String(orderNumber ?? "")]));
  const snapshot = new Set(row.lineIds);
  const selected = snapshot.size
    ? lines.filter(({ line }) => snapshot.has(line.id))
    : lines.filter(({ line }) => {
      const stamp = (line.sourceAt ?? line.createdAt).toISOString().slice(0, 10);
      return stamp >= row.periodFrom && stamp <= row.periodTo;
    });
  return {
    ...statementDto(row),
    lines: selected.map(({ line }) => ({
      id: line.id, settlementId: line.settlementId, orderNumber: numberById.get(line.settlementId) ?? "",
      grossPaise: line.grossPaise, commissionPaise: line.commissionPaise,
      gatewayFeePaise: line.gatewayFeePaise, taxPaise: line.taxPaise,
      refundPaise: line.refundPaise, adjustmentPaise: line.adjustmentPaise,
      netPaise: line.netPaise, source: line.source, createdAt: line.createdAt.toISOString(),
    })),
  };
}

/** Generate (or idempotently return) an immutable statement for a closed period. */
export async function generateStatement(businessId: string, input: {
  from: string; to: string; actorId: string;
}): Promise<StatementDetail> {
  const { start, end } = range(input.from, input.to);
  await listSettlementLines(businessId);
  const stamp = sql`coalesce(${settlements.paidAt}, ${settlements.createdAt})`;
  const rows = await db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines).innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(and(eq(settlementLines.businessId, businessId), gte(stamp, start), lt(stamp, end)))
    .orderBy(stamp);
  if (!rows.length) throw new ApiError("No settled orders fall inside this period.", 404);

  const number = `ST-${businessId.slice(0, 8).toUpperCase()}-${input.from}-${input.to}`;
  const [existing] = await db.select().from(settlementStatements).where(and(
    eq(settlementStatements.businessId, businessId), eq(settlementStatements.number, number),
  )).limit(1);
  if (existing) return statementDetail(businessId, existing.id);

  const amounts = aggregateStatement(rows.map(({ line }) => line));
  const checksum = createHash("sha256").update(rows.map(({ line }) => `${line.settlementId}:${line.netPaise}`).sort().join("|")).digest("hex").slice(0, 24);
  const [created] = await db.insert(settlementStatements).values({
    businessId, number, periodFrom: input.from, periodTo: input.to,
    ...amounts, lineCount: rows.length, status: "closed", checksum,
    lineIds: rows.map(({ line }) => line.id), generatedBy: input.actorId,
  }).returning();
  return statementDetail(businessId, created.id);
}

export async function financeSummary(businessId: string): Promise<FinanceSummary> {
  const lines = await listSettlementLines(businessId);
  const totals = aggregateStatement(lines);
  const [allocated, statementRows] = await Promise.all([
    db.select({ amount: sql<number>`coalesce(sum(${payoutAllocations.amountPaise}), 0)::int` })
      .from(payoutAllocations).where(eq(payoutAllocations.businessId, businessId)),
    db.select({ id: settlementStatements.id }).from(settlementStatements)
      .where(eq(settlementStatements.businessId, businessId)),
  ]);
  const allocatedPaise = allocated[0]?.amount ?? 0;
  return {
    ...totals,
    settlementCount: lines.length,
    statementCount: statementRows.length,
    allocatedPaise,
    unallocatedPaise: Math.max(0, totals.netPaise - allocatedPaise),
  };
}
