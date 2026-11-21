import "server-only";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, paymentAttempts, settlementLines, settlements } from "@/db/schema";
import { splitSettlement } from "@/lib/fee-math";
import { feeScheduleFor } from "@/lib/fee-schedules";
import type { SettlementLineRecord } from "@/lib/types";

function lineDto(row: typeof settlementLines.$inferSelect, orderNumber: string): SettlementLineRecord {
  return {
    id: row.id, settlementId: row.settlementId, orderNumber,
    grossPaise: row.grossPaise, commissionPaise: row.commissionPaise,
    gatewayFeePaise: row.gatewayFeePaise, taxPaise: row.taxPaise,
    refundPaise: row.refundPaise, adjustmentPaise: row.adjustmentPaise,
    netPaise: row.netPaise, source: row.source, createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Rebuild the derived gross → net split for every mirrored settlement. The authoritative
 * settlement amounts are never changed; adding a gateway/tax schedule creates a reconcilable
 * mismatch instead of rewriting source-of-truth money.
 */
export async function ensureSettlementLines(businessId: string): Promise<number> {
  const [{ values: schedule }, settlementRows, orderRows, attemptRows] = await Promise.all([
    feeScheduleFor(businessId),
    db.select().from(settlements).where(eq(settlements.businessId, businessId)),
    db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.businessId, businessId)),
    db.select({ id: paymentAttempts.id, orderId: paymentAttempts.orderId }).from(paymentAttempts)
      .where(eq(paymentAttempts.businessId, businessId)),
  ]);
  const orderByNumber = new Map(orderRows.map((row) => [row.orderNumber, row.id]));
  const attemptByOrder = new Map<string, string>();
  for (const attempt of attemptRows) if (!attemptByOrder.has(attempt.orderId)) attemptByOrder.set(attempt.orderId, attempt.id);

  const rows = settlementRows.map((settlement) => {
    const split = splitSettlement({
      grossPaise: settlement.grossAmount,
      authoritativeCommissionPaise: settlement.commissionAmount,
      refundPaise: settlement.refundAmount,
      adjustmentPaise: settlement.adjustmentAmount,
      schedule,
    });
    const orderId = settlement.orderNumber === null ? null : orderByNumber.get(settlement.orderNumber) ?? null;
    return {
      businessId, settlementId: settlement.id, orderId,
      paymentAttemptId: orderId ? attemptByOrder.get(orderId) ?? null : null,
      grossPaise: split.grossPaise, commissionPaise: split.commissionPaise,
      gatewayFeePaise: split.gatewayFeePaise, taxPaise: split.taxPaise,
      refundPaise: split.refundPaise, adjustmentPaise: split.adjustmentPaise,
      netPaise: split.netPaise, source: "marketplace",
      sourceAt: settlement.paidAt ?? settlement.createdAt,
    };
  });

  if (rows.length) {
    await db.insert(settlementLines).values(rows).onConflictDoUpdate({
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
        source: sql`excluded.source`,
        sourceAt: sql`excluded.source_at`,
      },
    });
  }
  return rows.length;
}

export async function listSettlementLines(businessId: string): Promise<SettlementLineRecord[]> {
  await ensureSettlementLines(businessId);
  const rows = await db.select({ line: settlementLines, orderNumber: settlements.orderNumber })
    .from(settlementLines)
    .innerJoin(settlements, eq(settlementLines.settlementId, settlements.id))
    .where(eq(settlementLines.businessId, businessId))
    .orderBy(settlements.createdAt);
  return rows.map(({ line, orderNumber }) => lineDto(line, String(orderNumber ?? "")));
}
