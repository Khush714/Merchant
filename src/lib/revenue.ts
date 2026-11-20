/**
 * Calendar controls for the Earnings → Revenue tab.
 *
 * Dates are inclusive YYYY-MM-DD labels in Asia/Kolkata, matching the business
 * day used by the Marketplace aggregation. Both the UI presets and the API use
 * these helpers so a selected range cannot mean one thing on screen and another
 * on the server.
 */

export type RevenuePreset = "1w" | "1m" | "6m" | "all" | "custom";
export type RevenueRange = { from: string | null; to: string | null };
export type NormalizedRevenueRange = {
  from: string | null;
  to: string | null;
  fromDate: Date | null;
  toExclusiveDate: Date | null;
};

export const REVENUE_PRESETS: { id: Exclude<RevenuePreset, "custom">; label: string }[] = [
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "6m", label: "6 months" },
  { id: "all", label: "All time" },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET = 5 * 3_600_000 + 30 * 60_000;

function todayLabel(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

function parts(label: string): [number, number, number] {
  const [year, month, day] = label.split("-").map(Number);
  return [year, month, day];
}

function format(utc: Date): string {
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(utc.getUTCDate()).padStart(2, "0")}`;
}

function shiftDays(label: string, days: number): string {
  const [year, month, day] = parts(label);
  return format(new Date(Date.UTC(year, month - 1, day - days)));
}

function shiftMonths(label: string, months: number): string {
  const [year, month, day] = parts(label);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return format(target);
}

/** Quick ranges end today and always produce a valid inclusive pair. */
export function rangeForPreset(preset: Exclude<RevenuePreset, "custom">, now = new Date()): RevenueRange {
  const today = todayLabel(now);
  if (preset === "all") return { from: null, to: null };
  if (preset === "1w") return { from: shiftDays(today, 7), to: today };
  if (preset === "1m") return { from: shiftMonths(today, 1), to: today };
  return { from: shiftMonths(today, 6), to: today };
}

function indiaStart(value: string): Date | null {
  if (!DATE.test(value)) return null;
  const [year, month, day] = parts(value);
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return new Date(utc - IST_OFFSET);
}

/** Returns null for any malformed or reversed range; null labels mean all time. */
export function normalizeRevenueRange(fromInput: unknown, toInput: unknown): NormalizedRevenueRange | null {
  const from = typeof fromInput === "string" ? fromInput.trim() : "";
  const to = typeof toInput === "string" ? toInput.trim() : "";
  if (!from && !to) return { from: null, to: null, fromDate: null, toExclusiveDate: null };
  if (!from || !to) return null;
  const fromDate = indiaStart(from);
  const toDate = indiaStart(to);
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) return null;
  return { from, to, fromDate, toExclusiveDate: new Date(toDate.getTime() + 86_400_000) };
}

/** The equal-length period immediately before a bounded range, for week/month comparisons. */
export function previousRevenueRange(range: NormalizedRevenueRange): NormalizedRevenueRange | null {
  if (!range.from || !range.to || !range.fromDate || !range.toExclusiveDate) return null;
  const [fromYear, fromMonth, fromDate] = parts(range.from);
  const [toYear, toMonth, toDate] = parts(range.to);
  const fromDay = Date.UTC(fromYear, fromMonth - 1, fromDate) / 86_400_000;
  const toDay = Date.UTC(toYear, toMonth - 1, toDate) / 86_400_000;
  const days = Math.max(1, toDay - fromDay + 1);
  const previousTo = fromDay - 1;
  const previousFrom = previousTo - days + 1;
  const label = (day: number) => format(new Date(day * 86_400_000));
  return normalizeRevenueRange(label(previousFrom), label(previousTo));
}

export function revenueRangeKey(range: RevenueRange): string {
  return range.from && range.to ? `${range.from}|${range.to}` : "all";
}

export function revenueRangeLabel(range: RevenueRange): string {
  if (!range.from || !range.to) return "All time";
  const formatLabel = (value: string) => new Date(`${value}T00:00:00+05:30`)
    .toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
  return `${formatLabel(range.from)} – ${formatLabel(range.to)}`;
}
