import "server-only";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payoutAllocations, payouts, settlementLines, settlements } from "@/db/schema";
import { marketplaceFetch } from "@/lib/marketplace-bridge";
import { PayoutPayloadError, parsePayoutFeed } from "@/lib/payout-payload";
import { ensureSettlementLines } from "@/lib/settlement-lines";
import { ApiError } from "@/lib/server";
import type { PayoutInbox, PayoutRecord } from "@/lib/types";

const STATUSES = new Set(["scheduled", "processing", "paid", "failed"]);
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(`${label} is required.`);
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  if (!clean) throw new ApiError(`${label} is required.`);
  return clean;
}
function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new ApiError(`${label} must be a positive whole number of paise.`);
  return value;
}
function date(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) throw new ApiError(`${label} must be a valid date.`);
  return new Date(value);
}

function dto(row: typeof payouts.$inferSelect, allocatedPaise: number): PayoutRecord {
  return {
    id: row.id, reference: row.reference, methodLabel: row.methodLabel, status: row.status,
    amountPaise: row.amountPaise, allocatedPaise, source: row.source,
    initiatedAt: row.initiatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listPayouts(businessId: string): Promise<PayoutInbox> {
  await ensureSettlementLines(businessId);
  const [rows, allocatedRows, lineTotal] = await Promise.all([
    db.select().from(payouts).where(eq(payouts.businessId, businessId)).orderBy(payouts.createdAt).limit(200),
    db.select({
      payoutId: payoutAllocations.payoutId,
      amount: sql<number>`coalesce(sum(${payoutAllocations.amountPaise}), 0)::int`,
    }).from(payoutAllocations).where(eq(payoutAllocations.businessId, businessId)).groupBy(payoutAllocations.payoutId),
    db.select({ amount: sql<number>`coalesce(sum(${settlementLines.netPaise}), 0)::int` })
      .from(settlementLines).where(eq(settlementLines.businessId, businessId)),
  ]);
  const allocatedByPayout = new Map(allocatedRows.map((row) => [row.payoutId, row.amount]));
  const totalPaise = rows.reduce((sum, row) => sum + row.amountPaise, 0);
  const completedPaise = rows.filter((row) => ["paid", "completed", "settled"].includes(row.status.toLowerCase()))
    .reduce((sum, row) => sum + row.amountPaise, 0);
  const allocatedPaise = allocatedRows.reduce((sum, row) => sum + row.amount, 0);
  return {
    available: true,
    notice: "No bank payout feed exists in Marketplace yet. Merchant records are manual or mirrored only where an upstream feed is exposed.",
    payouts: rows.map((row) => dto(row, allocatedByPayout.get(row.id) ?? 0)),
    summary: {
      totalPaise,
      completedPaise,
      unallocatedPaise: Math.max(0, (lineTotal[0]?.amount ?? 0) - allocatedPaise),
    },
  };
}

export async function recordPayout(businessId: string, input: {
  reference: unknown;
  methodLabel?: unknown;
  status?: unknown;
  amountPaise: unknown;
  initiatedAt?: unknown;
  completedAt?: unknown;
  source?: unknown;
  allocations: unknown;
}) {
  const reference = text(input.reference, "Payout reference", 128);
  const amountPaise = money(input.amountPaise, "Payout amount");
  const status = typeof input.status === "string" && STATUSES.has(input.status.toLowerCase()) ? input.status.toLowerCase() : "scheduled";
  const methodLabel = typeof input.methodLabel === "string" ? text(input.methodLabel, "Payout method", 120) : "";
  const initiatedAt = date(input.initiatedAt, "initiatedAt");
  const completedAt = date(input.completedAt, "completedAt");
  const source = typeof input.source === "string" && input.source === "marketplace" ? "marketplace" : "merchant_manual";
  if (!Array.isArray(input.allocations) || input.allocations.length > 500) throw new ApiError("Choose valid settlement allocations.");
  const allocations = input.allocations.map((entry) => {
    if (!entry || typeof entry !== "object") throw new ApiError("Invalid settlement allocation.");
    const row = entry as Record<string, unknown>;
    if (typeof row.settlementId !== "string" || !/^[0-9a-f-]{36}$/i.test(row.settlementId)) throw new ApiError("Invalid settlement allocation.");
    return { settlementId: row.settlementId, amountPaise: money(row.amountPaise, "Allocation amount") };
  });
  const allocated = allocations.reduce((sum, row) => sum + row.amountPaise, 0);
  if (allocated !== amountPaise) throw new ApiError("Allocations must add up to the payout amount.");

  const result = await db.transaction(async (tx) => {
    if (allocations.length) {
      const found = await tx.select({ id: settlements.id }).from(settlements)
        .where(andInBusiness(businessId, allocations.map((row) => row.settlementId)));
      if (found.length !== allocations.length) throw new ApiError("A selected settlement was not found for this outlet.", 404);
    }
    const [row] = await tx.insert(payouts).values({
      businessId, reference, methodLabel, status, amountPaise, initiatedAt, completedAt, source,
    }).onConflictDoUpdate({
      target: [payouts.businessId, payouts.reference],
      set: { methodLabel, status, amountPaise, initiatedAt, completedAt, source, updatedAt: new Date() },
    }).returning();
    await tx.delete(payoutAllocations).where(eq(payoutAllocations.payoutId, row.id));
    if (allocations.length) {
      await tx.insert(payoutAllocations).values(allocations.map((line) => ({
        businessId, payoutId: row.id, settlementId: line.settlementId, amountPaise: line.amountPaise,
      })));
    }
    return row;
  });
  return dto(result, allocated);
}

function andInBusiness(businessId: string, ids: string[]) {
  return sql`${settlements.businessId} = ${businessId} and ${settlements.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

/** Attempt a real upstream feed. A missing route returns an explicit unavailable result, never fake payouts. */
export async function syncPayouts(businessId: string) {
  let payload: unknown;
  try {
    payload = await marketplaceFetch(businessId, "/api/integration/merchant/payouts", { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { available: false, received: 0, applied: 0, message: "Marketplace does not expose a payout feed yet. Bank reconciliations must be recorded manually." };
    }
    throw error;
  }
  let feed;
  try { feed = parsePayoutFeed(payload); }
  catch (error) {
    if (error instanceof PayoutPayloadError) throw new ApiError(error.message, 502);
    throw error;
  }
  if (!feed.available) return { available: false, received: 0, applied: 0, message: feed.message };
  const externalIds = feed.payouts.flatMap((row) => row.allocations.map((line) => line.settlementExternalId));
  const matched = externalIds.length
    ? await db.select({ id: settlements.id, externalId: settlements.externalId })
      .from(settlements)
      .where(sql`${settlements.businessId} = ${businessId} and ${settlements.externalId} in (${sql.join(externalIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const byExternal = new Map(matched.map((row) => [row.externalId, row.id]));
  let applied = 0;
  for (const row of feed.payouts) {
    const allocations = row.allocations.flatMap((line) => {
      const id = byExternal.get(line.settlementExternalId);
      return id ? [{ settlementId: id, amountPaise: line.amountPaise }] : [];
    });
    await recordPayout(businessId, {
      reference: row.reference, methodLabel: row.methodLabel, status: row.status,
      amountPaise: row.amountPaise, initiatedAt: row.initiatedAt, completedAt: row.completedAt,
      source: "marketplace", allocations,
    });
    applied++;
  }
  return { available: true, received: feed.payouts.length, applied, message: "Payout mirror updated from Marketplace." };
}
