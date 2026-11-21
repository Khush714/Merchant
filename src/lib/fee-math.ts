/**
 * Pure paise-safe fee and settlement math. No server imports: the same rules run in the API,
 * statement builder, reconciliation engine and CI.
 *
 * A Marketplace settlement is authoritative: its commission/refund/adjustment numbers win.
 * A fee schedule may only add an explicit gateway/tax split; if that split changes the
 * authoritative net, reconciliation raises an exception instead of silently rewriting money.
 */

export type FeeScheduleValues = {
  commissionBps: number;
  platformFixedPaise: number;
  gatewayBps: number;
  gatewayFixedPaise: number;
  gstBps: number;
};

export type FeeBreakdown = {
  platformPaise: number;
  gatewayPaise: number;
  taxPaise: number;
  totalFeePaise: number;
  netPaise: number;
};

export type SettlementAmounts = {
  grossPaise: number;
  commissionPaise: number;
  gatewayFeePaise: number;
  taxPaise: number;
  refundPaise: number;
  adjustmentPaise: number;
};

export type SettlementSplit = SettlementAmounts & {
  netPaise: number;
  expectedNetPaise: number;
  matchesAuthoritative: boolean;
};

const MAX_PAISE = 2_147_483_647;

function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** Basis points are rounded half-up to the nearest paise; never use floating-point rupees for storage. */
export function bpsPaise(amountPaise: number, bps: number): number {
  integer(amountPaise, "amountPaise", 0, MAX_PAISE);
  integer(bps, "bps", 0, 10_000);
  return Math.round((amountPaise * bps) / 10_000);
}

export function validateSchedule(schedule: FeeScheduleValues): FeeScheduleValues {
  return {
    commissionBps: integer(schedule.commissionBps, "commissionBps", 0, 10_000),
    platformFixedPaise: integer(schedule.platformFixedPaise, "platformFixedPaise", 0, MAX_PAISE),
    gatewayBps: integer(schedule.gatewayBps, "gatewayBps", 0, 10_000),
    gatewayFixedPaise: integer(schedule.gatewayFixedPaise, "gatewayFixedPaise", 0, MAX_PAISE),
    gstBps: integer(schedule.gstBps, "gstBps", 0, 10_000),
  };
}

/** Calculate a scheduled fee split for a gross amount. Tax applies to fees, never to the food bill. */
export function calculateFeeBreakdown(grossPaise: number, schedule: FeeScheduleValues): FeeBreakdown {
  const safe = validateSchedule(schedule);
  const gross = integer(grossPaise, "grossPaise", 0, MAX_PAISE);
  const platformPaise = bpsPaise(gross, safe.commissionBps) + safe.platformFixedPaise;
  const gatewayPaise = bpsPaise(gross, safe.gatewayBps) + safe.gatewayFixedPaise;
  if (platformPaise > MAX_PAISE || gatewayPaise > MAX_PAISE) throw new Error("Fee schedule produces an out-of-range fee.");
  const taxPaise = bpsPaise(platformPaise + gatewayPaise, safe.gstBps);
  const totalFeePaise = platformPaise + gatewayPaise + taxPaise;
  return { platformPaise, gatewayPaise, taxPaise, totalFeePaise, netPaise: gross - totalFeePaise };
}

/** Gross → net waterfall. Adjustments may be negative; every other component is validated. */
export function settlementNetPaise(amounts: SettlementAmounts): number {
  const gross = integer(amounts.grossPaise, "grossPaise", 0, MAX_PAISE);
  const commission = integer(amounts.commissionPaise, "commissionPaise", 0, MAX_PAISE);
  const gateway = integer(amounts.gatewayFeePaise, "gatewayFeePaise", 0, MAX_PAISE);
  const tax = integer(amounts.taxPaise, "taxPaise", 0, MAX_PAISE);
  const refund = integer(amounts.refundPaise, "refundPaise", 0, MAX_PAISE);
  const adjustment = integer(amounts.adjustmentPaise, "adjustmentPaise", -MAX_PAISE, MAX_PAISE);
  return gross - commission - gateway - tax - refund + adjustment;
}

/**
 * Build the stored split for one mirrored settlement. `authoritativeCommission` is never
 * replaced; gateway/tax come from the configured schedule (zero by default).
 */
export function splitSettlement(input: {
  grossPaise: number;
  authoritativeCommissionPaise: number;
  refundPaise: number;
  adjustmentPaise: number;
  schedule: FeeScheduleValues | null;
}): SettlementSplit {
  const schedule = input.schedule ? validateSchedule(input.schedule) : null;
  const gatewayFeePaise = schedule ? bpsPaise(input.grossPaise, schedule.gatewayBps) + schedule.gatewayFixedPaise : 0;
  const taxPaise = schedule ? bpsPaise(input.authoritativeCommissionPaise + gatewayFeePaise, schedule.gstBps) : 0;
  const amounts: SettlementAmounts = {
    grossPaise: input.grossPaise,
    commissionPaise: input.authoritativeCommissionPaise,
    gatewayFeePaise,
    taxPaise,
    refundPaise: input.refundPaise,
    adjustmentPaise: input.adjustmentPaise,
  };
  const netPaise = settlementNetPaise(amounts);
  const expectedNetPaise = input.grossPaise - input.authoritativeCommissionPaise - input.refundPaise + input.adjustmentPaise;
  return { ...amounts, netPaise, expectedNetPaise, matchesAuthoritative: netPaise === expectedNetPaise };
}

/** Aggregate a closed set of settlement lines into statement totals. */
export function aggregateStatement(rows: readonly (SettlementAmounts & { netPaise: number })[]) {
  return rows.reduce((total, row) => ({
    grossPaise: total.grossPaise + row.grossPaise,
    commissionPaise: total.commissionPaise + row.commissionPaise,
    gatewayFeePaise: total.gatewayFeePaise + row.gatewayFeePaise,
    taxPaise: total.taxPaise + row.taxPaise,
    refundPaise: total.refundPaise + row.refundPaise,
    adjustmentPaise: total.adjustmentPaise + row.adjustmentPaise,
    netPaise: total.netPaise + row.netPaise,
  }), {
    grossPaise: 0, commissionPaise: 0, gatewayFeePaise: 0, taxPaise: 0,
    refundPaise: 0, adjustmentPaise: 0, netPaise: 0,
  });
}
