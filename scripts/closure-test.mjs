import assert from "node:assert/strict";
import {
  cleanClosureReason,
  closureState,
  indiaDate,
  parseClosureUntil,
  parseScheduledLeaves,
} from "../src/lib/closure.ts";

const now = new Date("2026-11-19T06:00:00.000Z"); // 11:30 IST
assert.equal(indiaDate(now), "2026-11-19");
assert.equal(closureState({ isOpen: true }, now).closed, false);
assert.equal(closureState({ isOpen: false }, now).closed, true);

const until = parseClosureUntil("2026-11-19T08:00:00.000Z", now);
assert.equal(closureState({ isOpen: true, closureUntil: until, closureReason: "Private event" }, now).closed, true);
// An expired window restores the base switch without a background job.
assert.equal(closureState({ isOpen: true, closureUntil: "2026-11-19T05:00:00.000Z" }, now).closed, false);

const leaves = parseScheduledLeaves([
  { date: "2026-11-19", reason: "Festival" },
  { date: "2026-11-19", reason: "duplicate" },
]);
assert.equal(leaves.length, 1);
assert.equal(leaves[0].reason, "Festival");
assert.equal(closureState({ isOpen: true, scheduledLeaves: leaves }, now).closed, true);
assert.equal(closureState({ isOpen: true, scheduledLeaves: leaves }, new Date("2026-11-20T06:00:00.000Z")).closed, false);

assert.equal(cleanClosureReason("  Lunch service  "), "Lunch service");
assert.throws(() => parseClosureUntil("2026-11-19T05:00:00.000Z", now));
assert.throws(() => parseScheduledLeaves([{ date: "2026-02-30" }]));
assert.throws(() => parseScheduledLeaves(Array.from({ length: 61 }, (_, i) => ({ date: "2026-12-01" }))));

console.log("PASS: temporary closure and scheduled leave rules");
