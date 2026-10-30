"use client";
import { ArrowRight, Bike, Check, ChefHat, Clock3, MoreHorizontal, ShoppingBag, Store } from "lucide-react";
import type { Order, OrderStatus } from "@/lib/types";
import { money } from "@/lib/types";

export type OrderAction = "accepted" | "rejected" | "preparing" | "ready" | "completed";
export const statusLabel: Record<OrderStatus, string> = { new: "New order", accepted: "Accepted", preparing: "Preparing", ready: "Ready", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled" };
export function timeAgo(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
export function OrderCard({ order, onAction, onDetails, busy = false }: { order: Order; onAction: (order: Order, action: OrderAction) => void; onDetails: (order: Order) => void; busy?: boolean }) {
  return <article className="order-card">
    <div className="order-card-top">
      <span className={`status-pill status-${order.status}`}><span className="status-dot" />{statusLabel[order.status]}</span>
      <button className="icon-button small" aria-label={`View order ${order.orderNumber}`} onClick={() => onDetails(order)}><MoreHorizontal size={20} /></button>
    </div>
    <div className="order-number-row"><button className="order-number" onClick={() => onDetails(order)}>#{order.orderNumber}</button><span className="order-time" suppressHydrationWarning><Clock3 size={14} /> {timeAgo(order.createdAt)}</span></div>
    <div className="order-meta"><span>{order.fulfilment === "delivery" ? <Bike size={15} /> : <Store size={15} />}{order.fulfilment === "delivery" ? "Delivery" : "Pickup"}</span><i /> <span>{order.customerName}</span></div>
    <div className="order-divider" />
    <div className="order-items">{order.items.slice(0, 3).map((item) => <div className="order-item-line" key={item.id}><span><b>{item.quantity} ×</b> {item.name}{item.modifiers?.length ? <small className="block muted">{item.modifiers.map((modifier) => `${modifier.quantity > 1 ? `${modifier.quantity} × ` : ""}${modifier.name}`).join(", ")}</small> : null}</span></div>)}{order.items.length > 3 && <span className="muted small-text">+ {order.items.length - 3} more items</span>}</div>
    {order.customerNote && <div className="order-note">“{order.customerNote}”</div>}
    <div className="order-total"><span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items <span className="meta-dot">·</span> {order.paymentStatus === "paid" ? "Paid" : "Payment pending"}</span><strong>{money(order.total)}</strong></div>
    <div className="order-actions">
      {order.status === "new" && <><button className="btn btn-outline" disabled={busy} onClick={() => onAction(order, "rejected")}>Reject</button><button className="btn btn-primary" disabled={busy} onClick={() => onAction(order, "accepted")}>Accept order <ArrowRight size={16} /></button></>}
      {order.status === "accepted" && <button className="btn btn-primary full" disabled={busy} onClick={() => onAction(order, "preparing")}><ChefHat size={16} /> Start preparing</button>}
      {order.status === "preparing" && <button className="btn btn-outline full" disabled={busy} onClick={() => onAction(order, "ready")}><Check size={16} /> Mark ready</button>}
      {order.status === "ready" && order.fulfilment === "pickup" && <button className="btn btn-outline full" disabled={busy} onClick={() => onAction(order, "completed")}><ShoppingBag size={16} /> Confirm handoff</button>}
      {order.status === "ready" && order.fulfilment === "delivery" && <div className="awaiting-delivery"><Bike size={15} /> Awaiting delivery confirmation</div>}
      {["completed", "cancelled", "rejected"].includes(order.status) && <button className="btn btn-ghost full" onClick={() => onDetails(order)}>View details <ArrowRight size={15} /></button>}
    </div>
  </article>;
}
