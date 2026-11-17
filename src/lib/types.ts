export type AuthUser = { id: string; email: string; emailVerified: boolean };
export type BusinessType = "restaurant" | "vendor";
export type OrderStatus = "new" | "accepted" | "preparing" | "ready" | "out_for_delivery" | "completed" | "rejected" | "cancelled";
export type Business = {
  id: string; type: BusinessType; name: string; ownerName: string; phone: string; address: string;
  category: string; registrationDetails: string; approvalStatus: "draft" | "pending" | "approved" | "rejected";
  isOpen: boolean; pickupEnabled: boolean; deliveryEnabled: boolean; hoursEnabled: boolean;
  opensAt: string; closesAt: string; updatedAt?: string;
};
export type AuthResponse = { user: AuthUser | null; business: Business | null; verificationRequired: boolean };
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
  status: "idle" | "synced" | "error";
  lastSyncedAt: string | null;
  message?: string;
};
export type Overview = {
  counts: Record<OrderStatus, number>;
  todaySales: number; todayOrders: number; completedToday: number; latestNewOrderId?: string | null;
  settlements: Settlement[];
  settlementSync: SettlementSync;
};
export const money = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
