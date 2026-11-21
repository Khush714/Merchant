import type { Business, FeedbackSummary, MenuItem, MenuModifierGroup, Offer, Order, Overview } from "@/lib/types";

// Explicitly isolated, non-persistent sample workspace. Never used by authenticated API routes.
export const demoBusiness: Business = { id: "demo", type: "restaurant", name: "The Curry Leaf", ownerName: "Ananya", phone: "", address: "Indiranagar, Bengaluru", category: "North Indian", registrationDetails: "", approvalStatus: "approved", isOpen: true, pickupEnabled: true, deliveryEnabled: true, hoursEnabled: true, opensAt: "09:00", closesAt: "22:00" };
export const demoMenu: MenuItem[] = [
  { id: "demo-item-1", businessId: "demo", name: "Butter Chicken", description: "Tender chicken in a rich, creamy tomato gravy", price: 38900, category: "Mains", imageUrl: "", dietary: "nonveg", available: true, archived: false, stockQuantity: null, modifierGroupIds: [] },
  { id: "demo-item-2", businessId: "demo", name: "Paneer Tikka Masala", description: "Grilled paneer in a fragrant spiced gravy", price: 34900, category: "Mains", imageUrl: "", dietary: "veg", available: true, archived: false, stockQuantity: null, modifierGroupIds: [] },
  { id: "demo-item-3", businessId: "demo", name: "Chicken Biryani", description: "Aromatic basmati rice, spices and chicken", price: 32900, category: "Rice & Biryani", imageUrl: "", dietary: "nonveg", available: true, archived: false, stockQuantity: null, modifierGroupIds: [] },
  { id: "demo-item-4", businessId: "demo", name: "Garlic Butter Naan", description: "Freshly baked and brushed with garlic butter", price: 8900, category: "Breads", imageUrl: "", dietary: "veg", available: true, archived: false, stockQuantity: null, modifierGroupIds: [] },
  { id: "demo-item-5", businessId: "demo", name: "Mango Lassi", description: "A sweet, creamy mango yogurt drink", price: 12900, category: "Drinks", imageUrl: "", dietary: "veg", available: false, archived: false, stockQuantity: null, modifierGroupIds: [] },
];

export const demoModifierGroups: MenuModifierGroup[] = [
  { id: "demo-group-size", name: "Size", minSelect: 1, maxSelect: 1, isActive: true, posSynced: false, itemCount: 0,
    options: [
      { id: "demo-option-regular", name: "Regular", priceCents: 0, isVeg: true, available: true, posSynced: false },
      { id: "demo-option-large", name: "Large", priceCents: 6000, isVeg: true, available: true, posSynced: false },
    ] },
  { id: "demo-group-extras", name: "Extra toppings", minSelect: 0, maxSelect: 2, isActive: true, posSynced: false, itemCount: 0,
    options: [
      { id: "demo-option-cheese", name: "Extra cheese", priceCents: 4000, isVeg: true, available: true, posSynced: false },
      { id: "demo-option-butter", name: "Extra butter", priceCents: 2000, isVeg: true, available: true, posSynced: false },
    ] },
];

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const noFeedback = { rating: null, review: "", feedbackAt: null, merchantResponse: "", merchantRespondedAt: null } as const;
const noOffer = { offerId: null, offerCode: "", discount: 0 } as const;
const stamp = (days: number) => ago(days * 1440);

export function makeDemoOrders(): Order[] {
  return [
    { id: "demo-order-1", orderNumber: 2847, businessId: "demo", customerName: "Rahul S.", customerNote: "Please make it less spicy.", total: 56700, status: "new", fulfilment: "delivery", deliveryAddress: "Indiranagar, Bengaluru", paymentStatus: "paid", paymentMethod: "online", prepMinutes: null, rejectionReason: "", ...noOffer, ...noFeedback, createdAt: ago(3), updatedAt: ago(3), items: [{ id: "a", name: "Butter Chicken", quantity: 1, unitPrice: 38900 }, { id: "b", name: "Garlic Butter Naan", quantity: 2, unitPrice: 8900 }] },
    { id: "demo-order-2", orderNumber: 2846, businessId: "demo", customerName: "Priya M.", customerNote: "", total: 47800, status: "new", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "paid", paymentMethod: "online", prepMinutes: null, rejectionReason: "", ...noOffer, ...noFeedback, createdAt: ago(6), updatedAt: ago(6), items: [{ id: "c", name: "Paneer Tikka Masala", quantity: 1, unitPrice: 34900 }, { id: "d", name: "Mango Lassi", quantity: 1, unitPrice: 12900 }] },
    { id: "demo-order-3", orderNumber: 2845, businessId: "demo", customerName: "Arjun K.", customerNote: "", total: 33440, status: "preparing", fulfilment: "delivery", deliveryAddress: "Indiranagar, Bengaluru", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 20, rejectionReason: "", offerId: "demo-offer-1", offerCode: "WELCOME20", discount: 8360, ...noFeedback, createdAt: ago(14), updatedAt: ago(10), items: [{ id: "e", name: "Chicken Biryani", quantity: 1, unitPrice: 32900 }, { id: "f", name: "Garlic Butter Naan", quantity: 1, unitPrice: 8900 }] },
    { id: "demo-order-6", orderNumber: 2848, businessId: "demo", customerName: "Meera T.", customerNote: "Leave at the door, please.", total: 38900, status: "out_for_delivery", fulfilment: "delivery", deliveryAddress: "12th Main, Indiranagar, Bengaluru", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 15, rejectionReason: "", ...noOffer, ...noFeedback, createdAt: ago(31), updatedAt: ago(4), items: [{ id: "i", name: "Butter Chicken", quantity: 1, unitPrice: 38900 }] },
    { id: "demo-order-4", orderNumber: 2844, businessId: "demo", customerName: "Neha R.", customerNote: "", total: 69800, status: "ready", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "unpaid", paymentMethod: "cash", prepMinutes: 15, rejectionReason: "", ...noOffer, ...noFeedback, createdAt: ago(26), updatedAt: ago(5), items: [{ id: "g", name: "Paneer Tikka Masala", quantity: 2, unitPrice: 34900 }] },
    { id: "demo-order-5", orderNumber: 2843, businessId: "demo", customerName: "Vikram P.", customerNote: "", total: 65800, status: "completed", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 20, rejectionReason: "", ...noOffer, rating: 2, review: "Biryani was cold by the time I collected it.", feedbackAt: ago(12), merchantResponse: "", merchantRespondedAt: null, createdAt: ago(44), updatedAt: ago(15), items: [{ id: "h", name: "Chicken Biryani", quantity: 2, unitPrice: 32900 }] },
    { id: "demo-order-7", orderNumber: 2842, businessId: "demo", customerName: "Sneha L.", customerNote: "", total: 47800, status: "completed", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 15, rejectionReason: "", ...noOffer, rating: 5, review: "Loved the naan, thank you!", feedbackAt: ago(55), merchantResponse: "Thanks for the kind words, Sneha!", merchantRespondedAt: ago(50), createdAt: ago(70), updatedAt: ago(49), items: [{ id: "j", name: "Paneer Tikka Masala", quantity: 1, unitPrice: 34900 }, { id: "k", name: "Garlic Butter Naan", quantity: 1, unitPrice: 8900 }] },
  ];
}

export function makeDemoOffers(orders: Order[]): Offer[] {
  const base: Offer[] = [
    { id: "demo-offer-1", businessId: "demo", code: "WELCOME20", title: "20% off your first order", description: "A little welcome from our kitchen. Minimum order ₹200.", discountType: "percent", value: 20, minOrder: 20000, maxDiscount: 15000, startsAt: null, endsAt: null, usageLimit: 100, active: true, archived: false, createdAt: stamp(10), updatedAt: stamp(2), redemptions: 0, discountGiven: 0, influencedGross: 0 },
    { id: "demo-offer-2", businessId: "demo", code: "FLAT100", title: "₹100 off above ₹499", description: "A flat saving on larger orders.", discountType: "flat", value: 10000, minOrder: 49900, maxDiscount: null, startsAt: null, endsAt: null, usageLimit: null, active: true, archived: false, createdAt: stamp(7), updatedAt: stamp(7), redemptions: 0, discountGiven: 0, influencedGross: 0 },
    { id: "demo-offer-3", businessId: "demo", code: "WEEKEND10", title: "10% off weekend specials", description: "Paused until the next weekend rush.", discountType: "percent", value: 10, minOrder: 0, maxDiscount: 10000, startsAt: null, endsAt: null, usageLimit: 50, active: false, archived: false, createdAt: stamp(21), updatedAt: stamp(4), redemptions: 0, discountGiven: 0, influencedGross: 0 },
  ];
  return base.map((offer) => {
    const used = orders.filter((order) => order.offerId === offer.id || order.offerCode === offer.code);
    return { ...offer, redemptions: used.length, discountGiven: used.reduce((sum, order) => sum + order.discount, 0), influencedGross: used.reduce((sum, order) => sum + order.total, 0) };
  });
}

export function demoOverview(orders: Order[]): Overview {
  const counts: Overview["counts"] = { new: 0, accepted: 0, preparing: 0, ready: 0, out_for_delivery: 0, completed: 0, rejected: 0, cancelled: 0 };
  orders.forEach((order) => counts[order.status]++);
  const reviewed = orders.filter((order) => order.feedbackAt && order.rating !== null);
  const ratings = reviewed.map((order) => order.rating as number);
  const feedback: FeedbackSummary = {
    available: true,
    windowDays: 30,
    averageRating: ratings.length ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10 : null,
    reviewCount: reviewed.length,
    badOrders: ratings.filter((rating) => rating <= 2).length,
    pendingReplies: reviewed.filter((order) => !order.merchantResponse).length,
  };
  return { counts, todaySales: 1845000, todayOrders: 38, completedToday: 31, settlements: [], settlementSync: { linked: false, status: "idle", lastSyncedAt: null }, settlementTotals: { count: 0, gross: 0, fees: 0, refunds: 0, adjustments: 0, net: 0 }, feedback };
}
