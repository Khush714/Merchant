import type { AppRole, StaffRole } from "@/lib/roles";

export type AuthUser = { id: string; email: string; emailVerified: boolean };
export type BusinessType = "restaurant" | "vendor";
export type OrderStatus = "new" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "rejected" | "cancelled";
export type Business = {
  id: string; type: BusinessType; name: string; ownerName: string; phone: string; address: string;
  category: string; registrationDetails: string; approvalStatus: "draft" | "pending" | "approved" | "rejected";
  isOpen: boolean; pickupEnabled: boolean; deliveryEnabled: boolean; hoursEnabled: boolean;
  opensAt: string; closesAt: string; updatedAt?: string;
};
export type AuthResponse = { user: AuthUser | null; business: Business | null; role: AppRole | null; verificationRequired: boolean };
export type StaffMember = {
  id: string; businessId: string; userId: string; email: string; role: StaffRole;
  status: "active" | "removed"; createdAt: string; updatedAt: string;
};
export type MenuItem = {
  id: string; businessId: string; name: string; description: string; price: number; category: string;
  imageUrl: string; dietary: string; available: boolean; archived: boolean;
};
export type OrderItem = { id: string; name: string; quantity: number; unitPrice: number; lineTotal?: number; modifiers?: { name: string; quantity: number; priceCents: number }[] };
export type Order = {
  id: string; orderNumber: number; businessId: string; customerName: string; customerNote: string;
  total: number; status: OrderStatus; fulfilment: "pickup" | "delivery"; deliveryAddress: string; paymentStatus: string;
  paymentMethod: string; prepMinutes: number | null; rejectionReason: string; createdAt: string;
  updatedAt: string; items: OrderItem[];
  rating: number | null; review: string; feedbackAt: string | null;
  merchantResponse: string; merchantRespondedAt: string | null;
  offerId: string | null; offerCode: string; discount: number;
  /** Provider-sourced state from signed webhooks; absent for demo and unpaired orders until an event arrives. */
  courierStatus?: string; courierTrackingId?: string; courierUpdatedAt?: string | null;
  paymentReference?: string; paymentUpdatedAt?: string | null;
};
export type SettlementStatus = "pending" | "paid" | "failed" | "reversed";
export type Settlement = {
  id: string; externalId: string; marketplaceOrderId: string; orderNumber: number | null;
  netAmount: number; grossAmount: number; commissionAmount: number; refundAmount: number; adjustmentAmount: number;
  currency: string; status: SettlementStatus; reference: string; paidAt: string | null;
  sourceUpdatedAt: string | null; createdAt: string;
};
export type SettlementSync = {
  linked: boolean;
  status: "idle" | "synced" | "throttled" | "truncated" | "error";
  lastSyncedAt: string | null;
  message?: string;
  canRetry?: boolean;
};
export type Overview = {
  counts: Record<OrderStatus, number>;
  todaySales: number; todayOrders: number; completedToday: number; latestNewOrderId?: string | null;
  settlements: Settlement[];
  settlementSync: SettlementSync;
  feedback: FeedbackSummary;
};
/** `available` is false for connected listings whose Marketplace does not publish feedback metrics. */
export type FeedbackSummary = {
  available: boolean;
  windowDays: number;
  averageRating: number | null;
  reviewCount: number;
  badOrders: number;
  pendingReplies: number;
};
export type DiscountType = "percent" | "flat";
/** Merchant view, including performance totals aggregated from redeemed orders. */
export type Offer = {
  id: string; businessId: string; code: string; title: string; description: string;
  discountType: DiscountType; value: number; minOrder: number; maxDiscount: number | null;
  startsAt: string | null; endsAt: string | null; usageLimit: number | null;
  active: boolean; archived: boolean; createdAt: string; updatedAt: string;
  redemptions: number; discountGiven: number; influencedGross: number;
};
export type OfferInput = {
  code: string; title: string; description: string; discountType: DiscountType;
  value: number; minOrder: number; maxDiscount: number | null;
  startsAt: string | null; endsAt: string | null; usageLimit: number | null; active: boolean;
};
/** Only non-sensitive promotion details are published on the public menu. */
export type PublicOffer = {
  code: string; title: string; description: string; discountType: DiscountType;
  value: number; minOrder: number; maxDiscount: number | null;
  startsAt: string | null; endsAt: string | null;
};
export const money = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
