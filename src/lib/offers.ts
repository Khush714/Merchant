import { money, type DiscountType, type Offer, type OfferInput, type PublicOffer } from "@/lib/types";

/** Pure promotion helpers shared by the merchant console, public menu and order transaction. */
export const OFFER_CODE_MAX = 40;
export const OFFER_CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;

type StoredOffer = {
  id: string; businessId: string; code: string; title: string; description: string;
  discountType: string; value: number; minOrder: number; maxDiscount: number | null;
  startsAt: Date | null; endsAt: Date | null; usageLimit: number | null;
  active: boolean; archived: boolean; createdAt: Date; updatedAt: Date;
};
type OfferMetrics = { redemptions?: number; discountGiven?: number; influencedGross?: number };

const iso = (value: Date) => value.toISOString();
const stamp = (value: Date | null) => value ? iso(value) : null;
const dateValue = (value: Date | string | null) => value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;

export function isOfferLive(offer: { startsAt: Date | string | null; endsAt: Date | string | null }, now = new Date()) {
  const time = now.getTime();
  if (!Number.isNaN(dateValue(offer.startsAt)) && dateValue(offer.startsAt) > time) return false;
  if (!Number.isNaN(dateValue(offer.endsAt)) && dateValue(offer.endsAt) <= time) return false;
  return true;
}

/** Discounts are always derived from the stored menu prices on the server, never from client input. */
export function calculateDiscount(offer: { discountType: string; value: number; maxDiscount: number | null }, subtotal: number) {
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0) return 0;
  let discount = offer.discountType === "percent" ? Math.floor((subtotal * offer.value) / 100) : offer.value;
  if (offer.discountType === "percent" && offer.maxDiscount !== null) discount = Math.min(discount, offer.maxDiscount);
  return Math.max(0, Math.min(discount, subtotal));
}

export function offerDto(row: StoredOffer, metrics: OfferMetrics = {}): Offer {
  return {
    id: row.id, businessId: row.businessId, code: row.code, title: row.title, description: row.description,
    discountType: row.discountType === "flat" ? "flat" : "percent", value: row.value,
    minOrder: row.minOrder, maxDiscount: row.maxDiscount,
    startsAt: stamp(row.startsAt), endsAt: stamp(row.endsAt), usageLimit: row.usageLimit,
    active: row.active, archived: row.archived, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    redemptions: metrics.redemptions ?? 0, discountGiven: metrics.discountGiven ?? 0,
    influencedGross: metrics.influencedGross ?? 0,
  };
}

export function publicOfferDto(row: StoredOffer): PublicOffer {
  return {
    code: row.code, title: row.title, description: row.description,
    discountType: row.discountType === "flat" ? "flat" : "percent", value: row.value,
    minOrder: row.minOrder, maxDiscount: row.maxDiscount,
    startsAt: stamp(row.startsAt), endsAt: stamp(row.endsAt),
  };
}

export function discountLabel(offer: { discountType: string; value: number }) {
  return offer.discountType === "flat" ? `${money(offer.value)} off` : `${offer.value}% off`;
}

export function parseOfferInput(body: Record<string, unknown>): OfferInput {
  const code = String(body.code ?? "").trim().toUpperCase();
  const title = String(body.title ?? "").trim();
  const description = String(body.description ?? "").trim();
  const discountType: DiscountType = body.discountType === "flat" ? "flat" : "percent";
  const value = Number(body.value);
  const minOrder = body.minOrder === undefined || body.minOrder === null || body.minOrder === "" ? 0 : Number(body.minOrder);
  const rawMax = body.maxDiscount;
  const maxDiscount = rawMax === undefined || rawMax === null || rawMax === "" ? null : Number(rawMax);
  const rawLimit = body.usageLimit;
  const usageLimit = rawLimit === undefined || rawLimit === null || rawLimit === "" ? null : Number(rawLimit);
  const active = body.active === undefined ? true : body.active === true;

  if (!OFFER_CODE_PATTERN.test(code)) throw new Error("Use a code of 3–40 letters, numbers, dashes or underscores.");
  if (title.length < 2 || title.length > 80) throw new Error("Add a short offer title (2–80 characters).");
  if (description.length > 300) throw new Error("Keep the description under 300 characters.");
  if (!Number.isSafeInteger(value) || (discountType === "percent" ? value < 1 || value > 100 : value < 100 || value > 10_000_000)) {
    throw new Error(discountType === "percent" ? "Enter a discount between 1% and 100%." : "Enter a flat discount between ₹1 and ₹100,000.");
  }
  if (!Number.isSafeInteger(minOrder) || minOrder < 0 || minOrder > 10_000_000) throw new Error("Enter a valid minimum order value.");
  if (maxDiscount !== null && (!Number.isSafeInteger(maxDiscount) || maxDiscount < 100 || maxDiscount > 10_000_000)) throw new Error("Enter a valid maximum discount.");
  if (usageLimit !== null && (!Number.isSafeInteger(usageLimit) || usageLimit < 1 || usageLimit > 1_000_000)) throw new Error("Enter a valid usage limit.");
  if (typeof body.active !== "undefined" && typeof body.active !== "boolean") throw new Error("Invalid offer status.");

  const startsAt = parseOptionalDate(body.startsAt, "Start date");
  const endsAt = parseOptionalDate(body.endsAt, "End date");
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) throw new Error("The end date must be after the start date.");
  return {
    code, title, description, discountType, value, minOrder, maxDiscount, usageLimit, active,
    startsAt: startsAt ? startsAt.toISOString() : null,
    endsAt: endsAt ? endsAt.toISOString() : null,
  };
}

function parseOptionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`Invalid ${label.toLowerCase()}.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${label.toLowerCase()}.`);
  return parsed;
}
