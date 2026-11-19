/**
 * Pure validation and normalization for paired Marketplace responses.
 *
 * The Marketplace is authoritative for the data itself, but Merchant must not
 * trust its transport shape. Every parser here either returns a complete local
 * DTO or throws `MarketplacePayloadError`; callers turn that into a 502. Keeping
 * this module free of `server-only` imports lets the same rules run in tests.
 */

import type { Business, FeedbackSummary, ItemAnalytics, ItemAnalyticsRow, MenuItem, Offer, Order, OrderStatus, Review, ReviewInbox, ReviewTheme, RevenueSummary } from "@/lib/types";

export const FEEDBACK_WINDOW_DAYS = 30;
export const MAX_REVIEW_CHARS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFER_CODE = /^[A-Z0-9_-]{3,40}$/;
const ORDER_CODE = /^[A-Za-z0-9_-]{4,64}$/;
const NUMERIC_ID = /^\d{1,12}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSURE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Preserve ordinary multiline customer input; reject only real control characters.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MARKETPLACE_STATUSES = ["PLACED", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED", "DELIVERED", "REJECTED", "CANCELLED"] as const;
const ORDER_STATUS: Record<string, OrderStatus> = {
  PLACED: "new", ACCEPTED: "accepted", PREPARING: "preparing", READY: "ready",
  OUT_FOR_DELIVERY: "out_for_delivery", COMPLETED: "completed", DELIVERED: "completed",
  REJECTED: "rejected", CANCELLED: "cancelled",
};

export class MarketplacePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplacePayloadError";
  }
}

function fail(message: string): never {
  throw new MarketplacePayloadError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length > max) fail(`${label} contains too many records.`);
  return value;
}

function text(value: unknown, label: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length > max) fail(`${label} is invalid.`);
  if (CONTROL.test(value) || (pattern && !pattern.test(value))) fail(`${label} is invalid.`);
  return value;
}

function optionalText(value: unknown, label: string, max: number, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return text(value, label, max);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid.`);
  return value;
}

function nullableInteger(value: unknown, label: string, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  return integer(value, label, min, max);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} is invalid.`);
  return value;
}

function iso(value: unknown, label: string, nullable = false): string | null {
  if (value === undefined || value === null) {
    if (nullable) return null;
    fail(`${label} is missing.`);
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

/** Lenient feedback extraction for order lists; malformed feedback is ignored, not invented. */
export function normalizeRemoteFeedback(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const nested = root.feedback;
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : root;
  const clean = (input: unknown) => typeof input === "string" ? input.trim().slice(0, MAX_REVIEW_CHARS) : "";
  const stamp = (input: unknown) => typeof input === "string" && Number.isFinite(Date.parse(input)) ? new Date(input).toISOString() : null;
  const rawRating = source.rating ?? source.customerRating;
  const rating = typeof rawRating === "number" && Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
  const review = clean(source.review ?? source.customerReview ?? source.comment);
  const merchantResponse = clean(source.merchantResponse ?? source.sellerResponse ?? source.reply);
  if (rating === null && !review && !merchantResponse) return null;
  return {
    rating,
    review,
    feedbackAt: stamp(source.feedbackAt ?? source.reviewedAt),
    merchantResponse,
    merchantRespondedAt: stamp(source.merchantRespondedAt ?? source.repliedAt),
  };
}

/** Strict version of the feedback reply written back from the Merchant App. */
export function parseRemoteFeedbackReply(payload: unknown) {
  const root = object(payload, "Marketplace response");
  const candidate = root.order ?? root.feedback ?? root;
  const source = object(candidate, "Feedback reply");
  const merchantResponse = text(source.merchantResponse ?? source.sellerResponse ?? source.reply ?? source.response, "merchantResponse", MAX_REVIEW_CHARS);
  if (!merchantResponse.trim()) fail("Marketplace returned an empty review reply.");
  const feedback = normalizeRemoteFeedback(source);
  return {
    rating: feedback?.rating ?? null,
    review: feedback?.review ?? "",
    feedbackAt: feedback?.feedbackAt ?? null,
    merchantResponse: merchantResponse.trim(),
    merchantRespondedAt: iso(source.merchantRespondedAt ?? source.repliedAt, "merchantRespondedAt", true),
  };
}

export function parseRemoteFeedbackSummary(value: unknown): FeedbackSummary {
  if (value === undefined || value === null) {
    return { available: false, windowDays: FEEDBACK_WINDOW_DAYS, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 };
  }
  const row = object(value, "Marketplace feedback summary");
  if (row.available === false) {
    return { available: false, windowDays: FEEDBACK_WINDOW_DAYS, averageRating: null, reviewCount: 0, badOrders: 0, pendingReplies: 0 };
  }
  const rawAverage = row.averageRating;
  const average = rawAverage === undefined || rawAverage === null || rawAverage === ""
    ? null
    : integer(Math.round(Number(rawAverage) * 10), "averageRating", 0, 50) / 10;
  return {
    available: true,
    windowDays: nullableInteger(row.windowDays, "windowDays", 1, 365) ?? FEEDBACK_WINDOW_DAYS,
    averageRating: average,
    reviewCount: integer(row.reviewCount, "reviewCount", 0, 10_000_000),
    badOrders: integer(row.badOrders, "badOrders", 0, 10_000_000),
    pendingReplies: integer(row.pendingReplies, "pendingReplies", 0, 10_000_000),
  };
}

/** Strict inbox parser: a paired response is either complete or treated as a bad upstream shape. */
export function parseRemoteFeedbackInbox(payload: unknown): ReviewInbox {
  const root = object(payload, "Marketplace response");
  if (root.ok !== true) fail("Marketplace review request failed.");
  const reviews = array(root.reviews, "Marketplace reviews", 100).map((value): Review => {
    const row = object(value, "Marketplace review");
    return {
      orderCode: text(row.orderCode, "review orderCode", 100, ORDER_CODE),
      rating: nullableInteger(row.rating, "review rating", 1, 5),
      review: optionalText(row.review, "review text", MAX_REVIEW_CHARS),
      feedbackAt: iso(row.feedbackAt, "review feedbackAt", true),
      merchantResponse: optionalText(row.merchantResponse, "review reply", MAX_REVIEW_CHARS),
      merchantRespondedAt: iso(row.merchantRespondedAt, "review merchantRespondedAt", true),
    };
  });
  const themes = array(root.themes, "Marketplace review themes", 10).map((value): ReviewTheme => {
    const row = object(value, "Marketplace review theme");
    const rawAverage = row.averageRating;
    return {
      key: text(row.key, "theme key", 40, /^[a-z0-9_-]{1,40}$/),
      label: text(row.label, "theme label", 60),
      count: integer(row.count, "theme count", 0, 10_000_000),
      averageRating: rawAverage === undefined || rawAverage === null || rawAverage === ""
        ? null
        : integer(Math.round(Number(rawAverage) * 10), "theme averageRating", 0, 50) / 10,
    };
  });
  return { reviews, summary: parseRemoteFeedbackSummary(object(root.summary, "Marketplace feedback summary")), themes };
}

/** Tiny change signal. Opaque tokens are compared, never interpreted. */
export function parseRemoteSyncVersion(payload: unknown): { ok: true; orders: string; feedback: string } {
  const root = object(payload, "Marketplace change signal response");
  if (root.ok !== true) fail("Marketplace change signal request failed.");
  return {
    ok: true,
    orders: text(root.orders, "orders change token", 512, /^[^\u0000-\u001f|]*(\|[^\u0000-\u001f|]*)*$/),
    feedback: text(root.feedback, "feedback change token", 512, /^[^\u0000-\u001f|]*(\|[^\u0000-\u001f|]*)*$/),
  };
}

/** Minimal acknowledgement parser for link checks, deletes and other write proxies. */
export function parseRemoteOk(payload: unknown): { ok: true } {
  const root = object(payload, "Marketplace response");
  if (root.ok !== true) fail("Marketplace did not acknowledge the request.");
  return { ok: true };
}

export type RemoteRestaurant = {
  name: string;
  isActive: boolean;
  merchantHoursEnabled: boolean;
  merchantOpensAt: string;
  merchantClosesAt: string;
  merchantPickupEnabled: boolean;
  merchantDeliveryEnabled: boolean;
  closureReason: string;
  closureUntil: string | null;
  scheduledLeaves: { date: string; reason: string }[];
};

export function parseRemoteRestaurant(value: unknown): RemoteRestaurant {
  const row = object(value, "Marketplace listing");
  return {
    name: text(row.name, "listing name", 120),
    isActive: bool(row.isActive, "listing isActive"),
    merchantHoursEnabled: bool(row.merchantHoursEnabled, "listing merchantHoursEnabled"),
    merchantOpensAt: text(row.merchantOpensAt, "opening time", 5, TIME),
    merchantClosesAt: text(row.merchantClosesAt, "closing time", 5, TIME),
    merchantPickupEnabled: bool(row.merchantPickupEnabled, "listing merchantPickupEnabled"),
    merchantDeliveryEnabled: bool(row.merchantDeliveryEnabled, "listing merchantDeliveryEnabled"),
    closureReason: optionalText(row.closureReason, "closure reason", 120),
    closureUntil: iso(row.closureUntil, "closure until", true),
    scheduledLeaves: (row.scheduledLeaves === undefined || row.scheduledLeaves === null
      ? []
      : array(row.scheduledLeaves, "scheduled leaves", 60).map((entry, index) => {
          const leave = object(entry, `scheduled leave ${index + 1}`);
          return {
            date: text(leave.date, `scheduled leave ${index + 1} date`, 10, CLOSURE_DATE),
            reason: optionalText(leave.reason, `scheduled leave ${index + 1} reason`, 80),
          };
        })),
  };
}

/** Listing writes return the authoritative restaurant under `restaurant`. */
export function parseRemoteRestaurantResponse(payload: unknown): RemoteRestaurant {
  const root = object(payload, "Marketplace listing response");
  if (root.ok !== true) fail("Marketplace did not acknowledge the listing change.");
  return parseRemoteRestaurant(root.restaurant);
}

type RemoteOwnedBusinessFields = Pick<Business, "name" | "approvalStatus" | "isOpen" | "hoursEnabled" | "opensAt" | "closesAt" | "pickupEnabled" | "deliveryEnabled" | "closureReason" | "closureUntil" | "scheduledLeaves">;

/** Local business fields always come from Merchant; only authoritative listing fields are overwritten. */
export function applyRemoteRestaurant<T extends object>(business: T, value: unknown): T & RemoteOwnedBusinessFields {
  const remote = parseRemoteRestaurant(value);
  return {
    ...business,
    name: remote.name,
    // A linked business already has a live Marketplace listing; the local
    // approval flag is a legacy setup field and must not mark it as pending.
    approvalStatus: "approved",
    isOpen: remote.isActive,
    hoursEnabled: remote.merchantHoursEnabled,
    opensAt: remote.merchantOpensAt,
    closesAt: remote.merchantClosesAt,
    pickupEnabled: remote.merchantPickupEnabled,
    deliveryEnabled: remote.merchantDeliveryEnabled,
    closureReason: remote.closureReason,
    closureUntil: remote.closureUntil,
    scheduledLeaves: remote.scheduledLeaves,
  };
}

const COUNT_KEYS: readonly OrderStatus[] = ["new", "accepted", "preparing", "ready", "out_for_delivery", "completed", "rejected", "cancelled"];

export function parseRemoteOverview(payload: unknown): {
  restaurant: RemoteRestaurant;
  overview: {
    counts: Record<OrderStatus, number>;
    todaySales: number;
    todayOrders: number;
    completedToday: number;
    latestNewOrderId: string | null;
    feedback: FeedbackSummary;
  };
} {
  const root = object(payload, "Marketplace overview response");
  if (root.ok !== true) fail("Marketplace overview request failed.");
  const restaurant = parseRemoteRestaurant(root.restaurant);
  const source = object(root.overview, "Marketplace overview metrics");
  const counts = object(source.counts, "Marketplace overview counts");
  const parsedCounts = {} as Record<OrderStatus, number>;
  for (const key of COUNT_KEYS) parsedCounts[key] = integer(counts[key], `count ${key}`, 0, 10_000_000);
  const latest = source.latestNewOrderId;
  if (latest !== undefined && latest !== null && typeof latest !== "string") fail("latestNewOrderId is invalid.");
  return {
    restaurant,
    overview: {
      counts: parsedCounts,
      todaySales: integer(source.todaySales, "todaySales", 0, 2_147_483_647),
      todayOrders: integer(source.todayOrders, "todayOrders", 0, 10_000_000),
      completedToday: integer(source.completedToday, "completedToday", 0, 10_000_000),
      latestNewOrderId: typeof latest === "string" ? text(latest, "latestNewOrderId", 128) : null,
      feedback: parseRemoteFeedbackSummary(source.feedback),
    },
  };
}

const REVENUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Revenue totals are calculated by Marketplace; this only guards the transport shape. */
export function parseRemoteRevenue(payload: unknown): RevenueSummary {
  const root = object(payload, "Marketplace revenue response");
  if (root.ok !== true) fail("Marketplace revenue request failed.");
  const source = object(root.revenue, "Marketplace revenue totals");
  const from = source.from === null ? null : text(source.from, "revenue from date", 10, REVENUE_DATE);
  const to = source.to === null ? null : text(source.to, "revenue to date", 10, REVENUE_DATE);
  if ((from === null) !== (to === null)) fail("Marketplace revenue range is incomplete.");
  if (source.currency !== "INR") fail("Marketplace revenue currency is unsupported.");
  return {
    from,
    to,
    grossSales: integer(source.grossSales, "grossSales", 0, Number.MAX_SAFE_INTEGER),
    netPaid: integer(source.netPaid, "netPaid", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    completedOrders: integer(source.completedOrders, "completedOrders", 0, 100_000_000),
    paidSettlements: integer(source.paidSettlements, "paidSettlements", 0, 100_000_000),
    currency: "INR",
  };
}

function parseRemoteOfferRow(value: unknown, businessId: string): Offer {
  const row = object(value, "Marketplace offer");
  const discountType = row.discountType === "flat" ? "flat" : row.discountType === "percent" ? "percent" : fail("Offer discountType is invalid.");
  return {
    id: text(row.id, "offer id", 50, UUID),
    businessId,
    code: text(row.code, "offer code", 40, OFFER_CODE),
    title: text(row.title, "offer title", 80),
    description: optionalText(row.description, "offer description", 300),
    discountType,
    value: integer(row.value, "offer value", 1, 10_000_000),
    minOrder: integer(row.minOrder, "offer minOrder", 0, 10_000_000),
    maxDiscount: nullableInteger(row.maxDiscount, "offer maxDiscount", 100, 10_000_000),
    startsAt: iso(row.startsAt, "offer startsAt", true),
    endsAt: iso(row.endsAt, "offer endsAt", true),
    usageLimit: nullableInteger(row.usageLimit, "offer usageLimit", 1, 1_000_000),
    active: bool(row.active, "offer active"),
    archived: bool(row.archived, "offer archived"),
    createdAt: iso(row.createdAt, "offer createdAt")!,
    updatedAt: iso(row.updatedAt, "offer updatedAt")!,
    redemptions: integer(row.redemptions ?? 0, "offer redemptions", 0, 10_000_000),
    discountGiven: integer(row.discountGiven ?? 0, "offer discountGiven", 0, 2_147_483_647),
    influencedGross: integer(row.influencedGross ?? 0, "offer influencedGross", 0, 2_147_483_647),
  };
}

export function parseRemoteOffers(payload: unknown, businessId: string): Offer[] {
  const root = object(payload, "Marketplace offers response");
  return array(root.offers, "Marketplace offers", 500).map((value) => parseRemoteOfferRow(value, businessId));
}

export function parseRemoteOffer(payload: unknown, businessId: string): Offer {
  const root = object(payload, "Marketplace offer response");
  return parseRemoteOfferRow(root.offer, businessId);
}

function parseRemoteMenuItem(value: unknown, businessId: string): MenuItem {
  const row = object(value, "Marketplace menu item");
  const dietary = optionalText(row.dietary, "menu dietary", 20, "unspecified");
  if (!["veg", "nonveg", "unspecified"].includes(dietary)) fail("menu dietary is invalid.");
  const imageUrl = optionalText(row.imageUrl, "menu imageUrl", 1000);
  if (imageUrl) {
    try {
      if (new URL(imageUrl).protocol !== "https:") throw new Error();
    } catch { fail("menu imageUrl is invalid."); }
  }
  return {
    id: text(row.id, "menu item id", 12, NUMERIC_ID),
    businessId,
    name: text(row.name, "menu item name", 120),
    description: optionalText(row.description, "menu item description", 500),
    price: integer(row.price, "menu item price", 0, 10_000_000),
    category: optionalText(row.category, "menu item category", 80, "Other") || "Other",
    imageUrl,
    dietary,
    available: bool(row.available, "menu item available"),
    archived: bool(row.archived, "menu item archived"),
  };
}

export function parseRemoteMenuItems(payload: unknown, businessId: string): MenuItem[] {
  const root = object(payload, "Marketplace menu response");
  return array(root.items, "Marketplace menu items", 500).map((value) => parseRemoteMenuItem(value, businessId));
}

export function parseRemoteMenu(payload: unknown, businessId: string): MenuItem {
  const root = object(payload, "Marketplace menu item response");
  return parseRemoteMenuItem(root.item, businessId);
}

function remoteStatus(value: unknown): OrderStatus {
  if (typeof value !== "string" || !(MARKETPLACE_STATUSES as readonly string[]).includes(value)) fail("Order status is invalid.");
  return ORDER_STATUS[value];
}

function parseRemoteOrder(value: unknown, businessId: string): Order {
  const row = object(value, "Marketplace order");
  const code = text(row.code, "order code", 64, ORDER_CODE);
  const feedback = normalizeRemoteFeedback(row);
  const items = array(row.items, "order items", 100).map((entry, index) => {
    const item = object(entry, `order item ${index + 1}`);
    const quantity = integer(item.quantity, `order item ${index + 1} quantity`, 1, 1000);
    const unitPrice = integer(item.priceCents, `order item ${index + 1} priceCents`, 0, 10_000_000);
    const modifiers = item.modifiers === undefined ? [] : array(item.modifiers, "order modifiers", 50).map((entry, modifierIndex) => {
      const modifier = object(entry, `modifier ${modifierIndex + 1}`);
      return {
        name: text(modifier.name, "modifier name", 120),
        quantity: integer(modifier.quantity, "modifier quantity", 1, 100),
        priceCents: integer(modifier.priceCents, "modifier priceCents", -10_000_000, 10_000_000),
      };
    });
    const lineTotal = unitPrice * quantity + modifiers.reduce((sum, modifier) => sum + modifier.priceCents * modifier.quantity, 0);
    return { id: `${code}-${index}`, name: text(item.name, "order item name", 120), quantity, unitPrice, lineTotal, modifiers };
  });
  const fulfilment = row.fulfilment === "pickup" || row.fulfilment === "delivery" ? row.fulfilment : fail("Order fulfilment is invalid.");
  return {
    // Paired order codes are alphanumeric; the UI renders orderNumber verbatim.
    id: code, orderNumber: code as unknown as number, businessId,
    customerName: optionalText(row.customerName, "customer name", 120, "Guest") || "Guest",
    customerNote: optionalText(row.instructions, "customer note", 500),
    total: integer(row.totalCents, "order total", 0, 2_147_483_647),
    status: remoteStatus(row.status),
    fulfilment,
    deliveryAddress: optionalText(row.addressText, "delivery address", 500),
    paymentStatus: optionalText(row.paymentStatus, "payment status", 40, "unpaid").toLowerCase(),
    paymentMethod: optionalText(row.paymentMethod, "payment method", 40, "online").toLowerCase(),
    prepMinutes: nullableInteger(row.prepMinutes, "prepMinutes", 0, 180),
    rejectionReason: row.rejectionReason === undefined || row.rejectionReason === null ? "" : text(row.rejectionReason, "rejectionReason", 250),
    createdAt: iso(row.createdAt, "order createdAt")!,
    updatedAt: iso(row.statusUpdatedAt, "order statusUpdatedAt")!,
    items,
    offerId: null,
    offerCode: optionalText(row.offerCode ?? row.promoCode, "offer code", 40),
    discount: integer(row.discountCents ?? 0, "order discount", 0, 2_147_483_647),
    rating: feedback?.rating ?? null,
    review: feedback?.review ?? "",
    feedbackAt: feedback?.feedbackAt ?? null,
    merchantResponse: feedback?.merchantResponse ?? "",
    merchantRespondedAt: feedback?.merchantRespondedAt ?? null,
  };
}

export function parseRemoteOrders(payload: unknown, businessId: string): { orders: Order[]; hasMore: boolean; page: number } {
  const root = object(payload, "Marketplace orders response");
  if (root.ok !== true) fail("Marketplace order list request failed.");
  const orders = array(root.orders, "Marketplace orders", 50).map((value) => parseRemoteOrder(value, businessId));
  const hasMore = bool(root.hasMore, "hasMore");
  return { orders, hasMore, page: integer(root.page ?? 1, "page", 1, 1000) };
}

/** Normalize the small `order` object returned by Marketplace status/fulfilment PATCHes. */
export function parseRemoteOrderMutation(payload: unknown, fallback: { id?: string; status?: OrderStatus; fulfilment?: "pickup" | "delivery"; addressText?: string } = {}): Partial<Order> {
  const root = object(payload, "Marketplace order response");
  const row = object(root.order, "updated order");
  const code = text(row.code ?? fallback.id, "order code", 64, ORDER_CODE);
  const result: Partial<Order> = {
    id: code,
    status: row.status === undefined ? fallback.status : remoteStatus(row.status),
    updatedAt: iso(row.statusUpdatedAt, "order statusUpdatedAt")!,
  };
  if (row.prepMinutes !== undefined && row.prepMinutes !== null) result.prepMinutes = integer(row.prepMinutes, "prepMinutes", 0, 180);
  if (typeof row.rejectionReason === "string") result.rejectionReason = text(row.rejectionReason, "rejectionReason", 250);
  if (row.fulfilment !== undefined) result.fulfilment = row.fulfilment === "pickup" || row.fulfilment === "delivery" ? row.fulfilment : fail("fulfilment is invalid.");
  if (row.addressText !== undefined) result.deliveryAddress = optionalText(row.addressText, "addressText", 500);
  else if (fallback.addressText !== undefined) result.deliveryAddress = fallback.addressText;
  if (!result.status) fail("updated order is missing its status.");
  return result;
}

export function parseRemotePairing(payload: unknown): { accessToken: string; restaurant: { id: number; name: string; slug: string } } {
  const root = object(payload, "Marketplace pairing response");
  if (root.ok !== true) fail("Marketplace pairing failed.");
  return {
    accessToken: text(root.accessToken, "accessToken", 500),
    restaurant: {
      id: integer(root.restaurant && (root.restaurant as Record<string, unknown>).id, "restaurant id", 1, 2_147_483_647),
      name: text((root.restaurant as Record<string, unknown>).name, "restaurant name", 120),
      slug: text((root.restaurant as Record<string, unknown>).slug, "restaurant slug", 120, /^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    },
  };
}
