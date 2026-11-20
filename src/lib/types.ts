import type { AppRole, StaffRole } from "@/lib/roles";
import type { DayPart, DeliveryZone, ServicePoint, WeeklyDayHours } from "@/lib/service-config";

export type { DayPart, DeliveryZone, ServicePoint, WeeklyDayHours } from "@/lib/service-config";

export type AuthUser = { id: string; email: string; emailVerified: boolean };
export type BusinessType = "restaurant" | "vendor";
export type OrderStatus = "new" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "rejected" | "cancelled";
export type Business = {
  id: string; type: BusinessType; name: string; ownerName: string; phone: string; address: string;
  category: string; registrationDetails: string; approvalStatus: "draft" | "pending" | "approved" | "rejected";
  isOpen: boolean; pickupEnabled: boolean; deliveryEnabled: boolean; hoursEnabled: boolean;
  opensAt: string; closesAt: string; updatedAt?: string;
  /** Optional overlays on isOpen; older demo and cached records may omit them. */
  closureReason?: string; closureUntil?: string | null; scheduledLeaves?: { date: string; reason: string }[];
  /** Optional map pin, service circles, weekly schedule and time-slot menus. Older rows omit them. */
  latitude?: number | null; longitude?: number | null; deliveryRadiusMeters?: number;
  deliveryZones?: DeliveryZone[]; weeklyHours?: WeeklyDayHours[]; dayParts?: DayPart[];
};
/** Outlet shown in the switcher. `role` is specific to this outlet, not to the account. */
export type BusinessOption = {
  id: string; name: string; type: BusinessType;
  approvalStatus: Business["approvalStatus"]; isOpen: boolean;
  role: AppRole; linked: boolean;
};
export type AuthResponse = {
  user: AuthUser | null;
  business: Business | null;
  role: AppRole | null;
  businesses: BusinessOption[];
  verificationRequired: boolean;
};
export type StaffMember = {
  id: string; businessId: string; userId: string; email: string; role: StaffRole;
  status: "active" | "removed"; createdAt: string; updatedAt: string;
};
export type MenuModifierOption = {
  id: string; name: string; priceCents: number; isVeg: boolean; available: boolean; posSynced: boolean;
};
export type MenuModifierGroup = {
  id: string; name: string; minSelect: number; maxSelect: number; isActive: boolean;
  options: MenuModifierOption[]; itemCount?: number; posSynced: boolean;
};
export type MenuItem = {
  id: string; businessId: string; name: string; description: string; price: number; category: string;
  imageUrl: string; dietary: string; available: boolean; archived: boolean;
  /** Null means untracked; zero is sold out. Paired items take this from Marketplace. */
  stockQuantity: number | null;
  modifierGroupIds: string[];
  posSynced?: boolean;
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
/** Marketplace-owned totals for the selected revenue period; money is in paise. */
export type RevenueSummary = {
  from: string | null;
  to: string | null;
  grossSales: number;
  netPaid: number;
  completedOrders: number;
  paidSettlements: number;
  currency: "INR";
};
/** One menu item's sales in the selected range; money is in paise. */
export type ItemAnalyticsRow = {
  itemId: string | null;
  name: string;
  unitsSold: number;
  grossSales: number;
  orders: number;
};
/** Paired reports come from Marketplace; unpaired/demo reports use local order lines. */
export type ItemAnalytics = {
  from: string | null;
  to: string | null;
  items: ItemAnalyticsRow[];
  unitsSold: number;
  grossSales: number;
  itemsSold: number;
  currency: "INR";
};
/** Order-level analytics for a range; money is in paise. Placement and completion dates are deliberately distinct. */
export type AdvancedKpis = {
  ordersPlaced: number;
  completionRate: number;
  discountsGiven: number;
  failedPayments: number;
};
export type AnalyticsDailyRow = { date: string; orders: number; completed: number; grossSales: number; discounts: number };
export type AnalyticsGroupRow = { label: string; orders: number; completed: number; grossSales: number };
export type AnalyticsOfferRow = { code: string; redemptions: number; discountGiven: number; grossSales: number };
/** Today's snapshot, grouped by the same India Standard Time day used by Revenue. */
export type AnalyticsToday = {
  date: string;
  revenue: number;
  completedOrders: number;
  ordersPlaced: number;
  averageOrderValue: number;
  completionRate: number;
};
export type AnalyticsHourRow = { hour: number; label: string; orders: number; completed: number; grossSales: number };
export type AnalyticsProductRow = {
  name: string;
  unitsSold: number;
  grossSales: number;
  orders: number;
  avgPrepMinutes: number | null;
};
export type AnalyticsReasonRow = { reason: string; orders: number; lostValue: number };
export type AnalyticsRepeat = {
  customers: number;
  repeatCustomers: number;
  repeatOrders: number;
  repeatRate: number;
  basis: string;
};
export type AnalyticsDeliveryRow = {
  label: string;
  orders: number;
  completed: number;
  cancelled: number;
  completionRate: number;
};
export type AnalyticsProfitability = {
  grossSales: number;
  discounts: number;
  commission: number;
  refunds: number;
  adjustments: number;
  netPaid: number;
  netAfterFees: number;
  source: "settlements" | "revenue" | "none";
};
export type AnalyticsComparisonRow = {
  label: string;
  current: number;
  previous: number;
  changePct: number | null;
  money: boolean;
};
/**
 * Order-level business intelligence for a range. Money stays in paise; every
 * breakdown is derived from order facts while the headline totals stay
 * Marketplace-owned for paired outlets.
 */
export type AdvancedAnalytics = {
  from: string | null;
  to: string | null;
  currency: "INR";
  source: "local" | "marketplace";
  /** Same definition as the Revenue tab (completion date), so the two views agree. */
  summary: RevenueSummary;
  kpis: AdvancedKpis | null;
  daily: AnalyticsDailyRow[];
  fulfilment: AnalyticsGroupRow[];
  payments: AnalyticsGroupRow[];
  offers: AnalyticsOfferRow[];
  today: AnalyticsToday;
  hourly: AnalyticsHourRow[];
  products: AnalyticsProductRow[];
  cancellations: AnalyticsReasonRow[];
  repeat: AnalyticsRepeat;
  delivery: AnalyticsDeliveryRow[];
  profitability: AnalyticsProfitability;
  comparison: AnalyticsComparisonRow[];
  comparisonLabel: string | null;
  ordersTruncated: boolean;
  notice?: string;
  truncated?: boolean;
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
/** A review row in the merchant inbox. For paired listings this is Marketplace-owned. */
export type Review = {
  orderCode: string;
  rating: number | null;
  review: string;
  feedbackAt: string | null;
  merchantResponse: string;
  merchantRespondedAt: string | null;
};
export type ReviewTheme = { key: string; label: string; count: number; averageRating: number | null };
export type ReviewInbox = { reviews: Review[]; summary: FeedbackSummary; themes: ReviewTheme[] };
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

// Compliance Phase 3 DTOs. All amounts are paise and all timestamps are ISO strings.
export type ComplianceStatus = "not_submitted" | "submitted" | "expired" | "needs_attention" | "not_applicable";
export type TaxRegime = "unregistered" | "regular" | "composition";
export type ComplianceDocumentKind = "kyc_identity" | "kyc_address" | "fssai_license" | "gst_registration" | "pan_card" | "bank_proof";
export type ComplianceAdvisory = {
  key: string;
  label: string;
  detail: string;
  severity: "info" | "warning";
};
export type ComplianceAgreementView = {
  version: string;
  title: string;
  body: string;
  contentHash: string;
  effectiveAt: string;
  accepted: boolean;
  acceptedAt: string | null;
};
export type ComplianceSummary = {
  legalName: string;
  entityType: string;
  gstin: string;
  pan: string;
  taxRegime: TaxRegime;
  taxInclusive: boolean;
  defaultTaxRateBps: number;
  fssaiNumber: string;
  fssaiExpiresAt: string | null;
  kycStatus: ComplianceStatus;
  fssaiStatus: ComplianceStatus;
  taxStatus: ComplianceStatus;
  payoutStatus: string;
  payoutMethodLabel: string;
  payoutReference: string;
  payoutSyncedAt: string | null;
  paired: boolean;
  advisories: ComplianceAdvisory[];
  agreement: ComplianceAgreementView;
};
export type ComplianceDocumentDto = {
  id: string;
  kind: ComplianceDocumentKind;
  label: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  uploadedBy: string | null;
};
export type ComplianceOverview = {
  compliance: ComplianceSummary;
  documents: ComplianceDocumentDto[];
  limits: { maxDocumentBytes: number; allowedContentTypes: string[] };
};
export type PayoutStatus = "not_configured" | "pending" | "configured" | "verified" | "action_required";
export type RemotePayout = {
  status: PayoutStatus;
  methodLabel: string;
  reference: string;
  updatedAt: string;
};
export type CompliancePayoutView = {
  available: boolean;
  authoritative: boolean;
  status: string;
  methodLabel: string;
  reference: string;
  syncedAt: string | null;
  message: string;
};
export type InvoiceSource = "marketplace" | "proforma";
export type InvoiceStatus = "issued" | "proforma" | "cancelled" | "void";
export type TaxInvoiceDto = {
  id: string;
  businessId: string;
  invoiceNumber: string;
  source: InvoiceSource;
  externalId: string;
  orderId: string;
  recipientName: string;
  recipientGstin: string;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
  sourceUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RemoteInvoice = {
  externalId: string;
  invoiceNumber: string;
  orderId: string;
  recipientName: string;
  recipientGstin: string;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
  updatedAt: string;
};
export type ComplianceInput = {
  legalName?: string;
  entityType?: string;
  gstin?: string;
  pan?: string;
  taxRegime?: TaxRegime;
  taxInclusive?: boolean;
  defaultTaxRateBps?: number;
  fssaiNumber?: string;
  fssaiExpiresAt?: string | null;
};

export const money = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
