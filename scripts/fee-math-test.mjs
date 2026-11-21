import assert from "node:assert/strict";
import {
  bpsPaise, calculateFeeBreakdown, settlementNetPaise, splitSettlement, aggregateStatement, validateSchedule,
} from "../src/lib/fee-math.ts";

assert.equal(bpsPaise(49_900, 600), 2_994, "6% is rounded half-up in paise");
assert.equal(bpsPaise(101, 50), 1);
assert.throws(() => bpsPaise(-1, 100));
assert.throws(() => bpsPaise(100, 10_001));

const schedule = { commissionBps: 600, platformFixedPaise: 0, gatewayBps: 200, gatewayFixedPaise: 100, gstBps: 1800 };
assert.deepEqual(calculateFeeBreakdown(10_000, schedule), {
  platformPaise: 600, gatewayPaise: 300, taxPaise: 162, totalFeePaise: 1_062, netPaise: 8_938,
});
assert.throws(() => validateSchedule({ ...schedule, gstBps: -1 }));

// Marketplace's authoritative feed has no gateway/tax split: defaults must preserve its net exactly.
const mirror = splitSettlement({
  grossPaise: 10_000, authoritativeCommissionPaise: 600, refundPaise: 0, adjustmentPaise: 0, schedule: null,
});
assert.equal(mirror.netPaise, 9_400);
assert.equal(mirror.matchesAuthoritative, true);

// An explicitly configured gateway fee is reported as a mismatch rather than silently swallowed.
const configured = splitSettlement({
  grossPaise: 10_000, authoritativeCommissionPaise: 600, refundPaise: 0, adjustmentPaise: 0,
  schedule: { commissionBps: 0, platformFixedPaise: 0, gatewayBps: 200, gatewayFixedPaise: 0, gstBps: 0 },
});
assert.equal(configured.gatewayFeePaise, 200);
assert.equal(configured.netPaise, 9_200);
assert.equal(configured.matchesAuthoritative, false);

assert.equal(settlementNetPaise({
  grossPaise: 10_000, commissionPaise: 600, gatewayFeePaise: 0, taxPaise: 0,
  refundPaise: 1_000, adjustmentPaise: -50,
}), 8_350);
assert.throws(() => settlementNetPaise({
  grossPaise: 10_000, commissionPaise: 600, gatewayFeePaise: 0, taxPaise: 0,
  refundPaise: -1, adjustmentPaise: 0,
}));

const totals = aggregateStatement([mirror, configured]);
assert.equal(totals.grossPaise, 20_000);
assert.equal(totals.commissionPaise, 1_200);
assert.equal(totals.gatewayFeePaise, 200);
assert.equal(totals.netPaise, 18_600);

console.log("PASS: fee breakdown and settlement waterfall math");
