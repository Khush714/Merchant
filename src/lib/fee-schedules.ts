import "server-only";

import { and, desc, eq, lte } from "drizzle-orm";
import { db } from "@/db";
import { feeSchedules } from "@/db/schema";
import { validateSchedule, type FeeScheduleValues } from "@/lib/fee-math";
import { ApiError } from "@/lib/server";
import type { FeeScheduleDto } from "@/lib/types";

/** Zero-fee default preserves Marketplace's authoritative net until an operator configures a split. */
export const DEFAULT_SCHEDULE: FeeScheduleValues = {
  commissionBps: 0,
  platformFixedPaise: 0,
  gatewayBps: 0,
  gatewayFixedPaise: 0,
  gstBps: 0,
};

type ScheduleRow = typeof feeSchedules.$inferSelect;

function dto(row: ScheduleRow | null, inherited: boolean): FeeScheduleDto {
  if (!row) {
    return {
      id: null, scope: "default", effectiveFrom: new Date(0).toISOString(),
      ...DEFAULT_SCHEDULE, active: true, inherited,
    };
  }
  return {
    id: row.id,
    scope: row.businessId ? "outlet" : "global",
    effectiveFrom: row.effectiveFrom.toISOString(),
    commissionBps: row.commissionBps,
    platformFixedPaise: row.platformFixedPaise,
    gatewayBps: row.gatewayBps,
    gatewayFixedPaise: row.gatewayFixedPaise,
    gstBps: row.gstBps,
    active: row.active,
    inherited,
  };
}

/** Outlet-specific schedules win over global ones; the newest effective version wins within a scope. */
export async function feeScheduleFor(businessId: string): Promise<{ values: FeeScheduleValues; dto: FeeScheduleDto }> {
  const rows = await db.select().from(feeSchedules).where(and(
    eq(feeSchedules.active, true),
    lte(feeSchedules.effectiveFrom, new Date()),
  )).orderBy(desc(feeSchedules.effectiveFrom)).limit(50);
  const selected = rows.find((row) => row.businessId === businessId) ?? rows.find((row) => row.businessId === null) ?? null;
  if (!selected) return { values: DEFAULT_SCHEDULE, dto: dto(null, true) };
  return {
    values: {
      commissionBps: selected.commissionBps,
      platformFixedPaise: selected.platformFixedPaise,
      gatewayBps: selected.gatewayBps,
      gatewayFixedPaise: selected.gatewayFixedPaise,
      gstBps: selected.gstBps,
    },
    dto: dto(selected, selected.businessId !== businessId),
  };
}

export async function currentFeeSchedule(businessId: string): Promise<FeeScheduleDto> {
  return (await feeScheduleFor(businessId)).dto;
}

/** Owner-only: replace the outlet's active version. Historical statements keep their own totals. */
export async function saveFeeSchedule(businessId: string, input: {
  commissionBps: number;
  platformFixedPaise: number;
  gatewayBps: number;
  gatewayFixedPaise: number;
  gstBps: number;
  effectiveFrom?: string;
}) {
  let values: FeeScheduleValues;
  try { values = validateSchedule(input); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Invalid fee schedule."); }
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
  if (!Number.isFinite(effectiveFrom.getTime())) throw new ApiError("effectiveFrom must be a valid date.");

  const row = await db.transaction(async (tx) => {
    await tx.update(feeSchedules).set({ active: false })
      .where(and(eq(feeSchedules.businessId, businessId), eq(feeSchedules.active, true)));
    const [created] = await tx.insert(feeSchedules).values({
      businessId, effectiveFrom, active: true, ...values,
    }).returning();
    return created;
  });
  return dto(row, false);
}
