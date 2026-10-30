import type { Business, MenuItem, Order, Overview } from "@/lib/types";

// Explicitly isolated, non-persistent sample workspace. Never used by authenticated API routes.
export const demoBusiness: Business = { id: "demo", type: "restaurant", name: "The Curry Leaf", ownerName: "Ananya", phone: "", address: "Indiranagar, Bengaluru", category: "North Indian", registrationDetails: "", approvalStatus: "approved", isOpen: true, pickupEnabled: true, deliveryEnabled: true, hoursEnabled: true, opensAt: "09:00", closesAt: "22:00" };
export const demoMenu: MenuItem[] = [
  { id: "demo-item-1", businessId: "demo", name: "Butter Chicken", description: "Tender chicken in a rich, creamy tomato gravy", price: 38900, category: "Mains", imageUrl: "/images/butter-chicken.jpg", dietary: "nonveg", available: true, archived: false },
  { id: "demo-item-2", businessId: "demo", name: "Paneer Tikka Masala", description: "Grilled paneer in a fragrant spiced gravy", price: 34900, category: "Mains", imageUrl: "/images/paneer.jpg", dietary: "veg", available: true, archived: false },
  { id: "demo-item-3", businessId: "demo", name: "Chicken Biryani", description: "Aromatic basmati rice, spices and chicken", price: 32900, category: "Rice & Biryani", imageUrl: "/images/biryani.jpg", dietary: "nonveg", available: true, archived: false },
  { id: "demo-item-4", businessId: "demo", name: "Garlic Butter Naan", description: "Freshly baked and brushed with garlic butter", price: 8900, category: "Breads", imageUrl: "", dietary: "veg", available: true, archived: false },
  { id: "demo-item-5", businessId: "demo", name: "Mango Lassi", description: "A sweet, creamy mango yogurt drink", price: 12900, category: "Drinks", imageUrl: "", dietary: "veg", available: false, archived: false },
];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export function makeDemoOrders(): Order[] {
  return [
    { id: "demo-order-1", orderNumber: 2847, businessId: "demo", customerName: "Rahul S.", customerNote: "Please make it less spicy.", total: 56700, status: "new", fulfilment: "delivery", deliveryAddress: "Indiranagar, Bengaluru", paymentStatus: "paid", paymentMethod: "online", prepMinutes: null, rejectionReason: "", createdAt: ago(3), updatedAt: ago(3), items: [{ id: "a", name: "Butter Chicken", quantity: 1, unitPrice: 38900 }, { id: "b", name: "Garlic Butter Naan", quantity: 2, unitPrice: 8900 }] },
    { id: "demo-order-2", orderNumber: 2846, businessId: "demo", customerName: "Priya M.", customerNote: "", total: 47800, status: "new", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "paid", paymentMethod: "online", prepMinutes: null, rejectionReason: "", createdAt: ago(6), updatedAt: ago(6), items: [{ id: "c", name: "Paneer Tikka Masala", quantity: 1, unitPrice: 34900 }, { id: "d", name: "Mango Lassi", quantity: 1, unitPrice: 12900 }] },
    { id: "demo-order-3", orderNumber: 2845, businessId: "demo", customerName: "Arjun K.", customerNote: "", total: 41800, status: "preparing", fulfilment: "delivery", deliveryAddress: "Indiranagar, Bengaluru", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 20, rejectionReason: "", createdAt: ago(14), updatedAt: ago(10), items: [{ id: "e", name: "Chicken Biryani", quantity: 1, unitPrice: 32900 }, { id: "f", name: "Garlic Butter Naan", quantity: 1, unitPrice: 8900 }] },
    { id: "demo-order-4", orderNumber: 2844, businessId: "demo", customerName: "Neha R.", customerNote: "", total: 69800, status: "ready", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "unpaid", paymentMethod: "cash", prepMinutes: 15, rejectionReason: "", createdAt: ago(26), updatedAt: ago(5), items: [{ id: "g", name: "Paneer Tikka Masala", quantity: 2, unitPrice: 34900 }] },
    { id: "demo-order-5", orderNumber: 2843, businessId: "demo", customerName: "Vikram P.", customerNote: "", total: 65800, status: "completed", fulfilment: "pickup", deliveryAddress: "", paymentStatus: "paid", paymentMethod: "online", prepMinutes: 20, rejectionReason: "", createdAt: ago(44), updatedAt: ago(15), items: [{ id: "h", name: "Chicken Biryani", quantity: 2, unitPrice: 32900 }] },
  ];
}
export function demoOverview(orders: Order[]): Overview {
  const counts: Overview["counts"] = { new: 0, accepted: 0, preparing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
  orders.forEach((order) => counts[order.status]++);
  return { counts, todaySales: 1845000, todayOrders: 38, completedToday: 31, settlements: [] };
}
