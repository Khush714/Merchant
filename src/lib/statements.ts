import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  payoutAllocations, settlementLines, settlementStatements, settlements,
} from "@/db/schema";
import { aggregateStatement } from "@/lib/fee-math";
import { ApiError } from "@/lib/server";
import type {
  FinanceSummary, SettlementLineRecord, SettlementLineSnapshot, StatementDetail, StatementRecord,
} from "@/lib/types";

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

type LineRow = typeof settlementLines.$inferSelect;
function lineRecord(line: LineRow, orderNumber: number | null): SettlementLineRecord {
  return {
    id: line.id, settlementId: line.settlementId, orderNumber: String(orderNumber ?? ""),
    grossPaise: line.grossPaise, commissionPaise: line.commissionPaise,
    gatewayFeePaise: line.gatewayFeePaise, taxPaise: line.taxPaise,
    refundPaise: line.refundPaise, adjustmentPaise: line.adjustmentPaise,
    netPaise: line.netPaise, source: line.source, createdAt: line.createdAt.toISOString(),
    lineVersion: line.lineVersion, feeScheduleId: line.feeScheduleId,
    sourceUpdatedAt: line.sourceUpdatedAt?.toISOString() ?? null,
    rebuiltAt: line.rebuiltAt?.toISOString() ?? null,
    expectedNetPaise: line.expectedNetPaise, matchesAuthoritative: line.matchesAuthoritative,
  };
}

function lineSnapshot(line: LineRow, orderNumber: number | null): SettlementLineSnapshot {
  const record = lineRecord(line, orderNumber);
  return {
    ...record,
    lineVersion: record.lineVersion ?? "legacy",
    feeScheduleId: record.feeScheduleId ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null,
    rebuiltAt: record.rebuiltAt ?? null,
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
  const header = statementDto(row);

  // New statements carry frozen line amounts. Older rows fall back to their stored line ids
  // and, for the oldest records, the original date-range filter.
  if (Array.isArray(row.lineSnapshot) && row.lineSnapshot.length) {
    return { ...header, lines: row.lineSnapshot };
  }

  const selectLines = () => db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines)
    .innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(eq(settlementLines.businessId, businessId))
    .orderBy(settlements.createdAt, settlementLines.id);

  if (!row.lineIds.length) {
    const lines = await selectLines();
    const selected = lines.filter(({ line }) => {
      const stamp = (line.sourceAt ?? line.createdAt).toISOString().slice(0, 10);
      return stamp >= row.periodFrom && stamp <= row.periodTo;
    });
    return { ...header, lines: selected.map(({ line, orderNumber }) => lineRecord(line, orderNumber)) };
  }

  const snapshot = new Set(row.lineIds);
  const lines = await db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines)
    .innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(and(
      eq(settlementLines.businessId, businessId),
      inArray(settlementLines.id, [...snapshot]),
    ))
    .orderBy(settlements.createdAt, settlementLines.id);
  return { ...header, lines: lines.map(({ line, orderNumber }) => lineRecord(line, orderNumber)) };
}

/** Generate (or idempotently return) an immutable statement for a closed period. */
export async function generateStatement(businessId: string, input: {
  from: string; to: string; actorId: string;
}): Promise<StatementDetail> {
  const { start, end } = range(input.from, input.to);
  const stamp = sql`coalesce(${settlements.paidAt}, ${settlements.createdAt})`;
  const rows = await db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines).innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(and(eq(settlementLines.businessId, businessId), gte(stamp, start), lt(stamp, end)))
    .orderBy(stamp, settlementLines.id);
  if (!rows.length) throw new ApiError("No settled orders fall inside this period.", 404);

  const number = `ST-${businessId.slice(0, 8).toUpperCase()}-${input.from}-${input.to}`;
  const [existing] = await db.select().from(settlementStatements).where(and(
    eq(settlementStatements.businessId, businessId), eq(settlementStatements.number, number),
  )).limit(1);
  if (existing) return statementDetail(businessId, existing.id);

  const amounts = aggregateStatement(rows.map(({ line }) => line));
  const lines = rows.map(({ line, orderNumber }) => lineSnapshot(line, orderNumber));
  const checksum = createHash("sha256").update(rows.map(({ line }) => `${line.settlementId}:${line.netPaise}`).sort().join("|")).digest("hex").slice(0, 24);
  const [created] = await db.insert(settlementStatements).values({
    businessId, number, periodFrom: input.from, periodTo: input.to,
    ...amounts, lineCount: rows.length, status: "closed", checksum,
    lineIds: lines.map((line) => line.id), lineSnapshot: lines, generatedBy: input.actorId,
  }).returning();
  return statementDetail(businessId, created.id);
}

/** SQL-side totals keep finance reads bounded and identical to the stored derived lines. */
export async function financeSummary(businessId: string): Promise<FinanceSummary> {
  const [totalRows, allocatedRows, statementCountRows] = await Promise.all([
    db.select({
      grossPaise: sql<number>`coalesce(sum(${settlementLines.grossPaise}), 0)::int`,
      commissionPaise: sql<number>`coalesce(sum(${settlementLines.commissionPaise}), 0)::int`,
      gatewayFeePaise: sql<number>`coalesce(sum(${settlementLines.gatewayFeePaise}), 0)::int`,
      taxPaise: sql<number>`coalesce(sum(${settlementLines.taxPaise}), 0)::int`,
      refundPaise: sql<number>`coalesce(sum(${settlementLines.refundPaise}), 0)::int`,
      adjustmentPaise: sql<number>`coalesce(sum(${settlementLines.adjustmentPaise}), 0)::int`,
      netPaise: sql<number>`coalesce(sum(${settlementLines.netPaise}), 0)::int`,
      settlementCount: sql<number>`count(${settlementLines.id})::int`,
    }).from(settlementLines).where(eq(settlementLines.businessId, businessId)),
    db.select({ amount: sql<number>`coalesce(sum(${payoutAllocations.amountPaise}), 0)::int` })
      .from(payoutAllocations).where(eq(payoutAllocations.businessId, businessId)),
    db.select({ count: sql<number>`count(*)::int` }).from(settlementStatements)
      .where(eq(settlementStatements.businessId, businessId)),
  ]);
  const totals = totalRows[0];
  const allocated = allocatedRows[0];
  const statementRows = statementCountRows[0];
  const money = totals ?? {
    grossPaise: 0, commissionPaise: 0, gatewayFeePaise: 0, taxPaise: 0,
    refundPaise: 0, adjustmentPaise: 0, netPaise: 0, settlementCount: 0,
  };
  const allocatedPaise = Number(allocated?.amount ?? 0);
  const netPaise = Number(money.netPaise ?? 0);
  return {
    grossPaise: Number(money.grossPaise ?? 0),
    commissionPaise: Number(money.commissionPaise ?? 0),
    gatewayFeePaise: Number(money.gatewayFeePaise ?? 0),
    taxPaise: Number(money.taxPaise ?? 0),
    refundPaise: Number(money.refundPaise ?? 0),
    adjustmentPaise: Number(money.adjustmentPaise ?? 0),
    netPaise,
    settlementCount: Number(money.settlementCount ?? 0),
    statementCount: Number(statementRows?.count ?? 0),
    allocatedPaise,
    unallocatedPaise: Math.max(0, netPaise - allocatedPaise),
  };
}
