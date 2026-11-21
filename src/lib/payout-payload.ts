/** Pure parser for an optional Marketplace payout feed. A missing feed is never invented locally. */

export class PayoutPayloadError extends Error {}

export type ParsedPayout = {
  reference: string;
  methodLabel: string;
  status: string;
  amountPaise: number;
  initiatedAt: string | null;
  completedAt: string | null;
  allocations: { settlementExternalId: string; amountPaise: number }[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PayoutPayloadError(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new PayoutPayloadError(`${label} is invalid.`);
  const clean = value.trim();
  if (required && !clean) throw new PayoutPayloadError(`${label} is required.`);
  return clean;
}
function money(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new PayoutPayloadError(`${label} is invalid.`);
  return value;
}
function iso(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) throw new PayoutPayloadError(`${label} is invalid.`);
  return new Date(value).toISOString();
}

export function parsePayoutFeed(payload: unknown): { available: boolean; payouts: ParsedPayout[]; message: string } {
  const root = object(payload, "Payout feed");
  if (root.available === false) {
    return { available: false, payouts: [], message: text(root.message ?? "The payout feed is not available upstream.", "message", 300) };
  }
  if (root.ok === false) throw new PayoutPayloadError("Payout feed request failed.");
  const rows = root.payouts;
  if (!Array.isArray(rows) || rows.length > 500) throw new PayoutPayloadError("Payout feed rows are invalid.");
  return {
    available: true,
    message: "",
    payouts: rows.map((entry, index) => {
      const row = object(entry, `Payout ${index + 1}`);
      const allocationsRaw = row.allocations ?? [];
      if (!Array.isArray(allocationsRaw) || allocationsRaw.length > 500) throw new PayoutPayloadError("Payout allocations are invalid.");
      return {
        reference: text(row.reference, "payout reference", 128, true),
        methodLabel: text(row.methodLabel ?? "", "payout method", 120),
        status: text(row.status ?? "scheduled", "payout status", 40),
        amountPaise: money(row.amountPaise, "payout amount"),
        initiatedAt: iso(row.initiatedAt, "initiatedAt"),
        completedAt: iso(row.completedAt, "completedAt"),
        allocations: allocationsRaw.map((item, lineIndex) => {
          const line = object(item, `Payout allocation ${lineIndex + 1}`);
          return {
            settlementExternalId: text(line.settlementExternalId, "settlementExternalId", 128, true),
            amountPaise: money(line.amountPaise, "allocation amount"),
          };
        }),
      };
    }),
  };
}
