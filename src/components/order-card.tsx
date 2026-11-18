"use client";
import { ArrowRight, Bike, Check, ChefHat, Clock3, MapPin, MoreHorizontal, ShoppingBag, Star, Store } from "lucide-react";
import type { Order, OrderStatus } from "@/lib/types";
import { money } from "@/lib/types";

export type OrderAction = "accepted" | "rejected" | "preparing" | "ready" | "out_for_delivery" | "completed";
export const statusLabel: Record<OrderStatus, string> = { new: "New order", accepted: "Accepted", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled" };
const courierLabel: Record<string, string> = { assigned: "Rider assigned", picked_up: "Picked up", out_for_delivery: "Out for delivery", delivered: "Delivered by courier", failed: "Courier failed" };
const paymentLabel: Record<string, string> = { authorized: "Authorized", paid: "Paid", failed: "Payment failed", refunded: "Refunded" };
export function timeAgo(value: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}
const activeStatuses: OrderStatus[] = ["new", "accepted", "preparing", "ready"];
export function OrderCard({ order, onAction, onDetails, onFulfilmentChange, fulfilmentSettings, busy = false, fulfilmentBusy = false }: {
  order: Order;
  onAction: (order: Order, action: OrderAction) => void;
  onDetails: (order: Order) => void;
  onFulfilmentChange?: (order: Order, fulfilment: "pickup" | "delivery") => void;
  fulfilmentSettings?: { pickup: boolean; delivery: boolean };
  busy?: boolean;
  fulfilmentBusy?: boolean;
}) {
  const canPickup = fulfilmentSettings?.pickup ?? true, canDelivery = fulfilmentSettings?.delivery ?? true;
  const changeFulfilment = (fulfilment: "pickup" | "delivery") => {
    if (fulfilmentBusy || busy || fulfilment === order.fulfilment) return;
    if ((fulfilment === "pickup" && !canPickup) || (fulfilment === "delivery" && !canDelivery)) return;
    onFulfilmentChange?.(order, fulfilment);
  };
  return <article className="order-card">
    <div className="order-card-top">
      <span className={`status-pill status-${order.status}`}><span className="status-dot" />{statusLabel[order.status]}</span>
      {order.rating !== null && <span className={`order-rating ${order.rating <= 2 ? "negative" : ""}`} title={`Customer rating: ${order.rating} of 5`}><Star size={13} fill="currentColor" /> {order.rating}/5{order.merchantResponse ? "" : " · reply?"}</span>}
      {order.discount > 0 && <span className="order-discount" title={order.offerCode ? `Offer ${order.offerCode}` : "Offer applied"}>{money(order.discount)} off</span>}
      {order.courierStatus && <span className={`provider-chip ${order.courierStatus === "failed" ? "negative" : ""}`} title={order.courierTrackingId ? `Tracking ${order.courierTrackingId}` : "Courier provider update"}><Bike size={12} /> {courierLabel[order.courierStatus] ?? order.courierStatus}</span>}
      <button className="icon-button small" aria-label={`View order ${order.orderNumber}`} onClick={() => onDetails(order)}><MoreHorizontal size={20} /></button>
    </div>
    <div className="order-number-row"><button className="order-number" onClick={() => onDetails(order)}>#{order.orderNumber}</button><span className="order-time" suppressHydrationWarning><Clock3 size={14} /> {timeAgo(order.createdAt)}</span></div>
    <div className="order-meta"><span>{order.fulfilment === "delivery" ? <Bike size={15} /> : <Store size={15} />}{order.fulfilment === "delivery" ? "Delivery" : "Pickup"}</span><i /> <span>{order.customerName}</span></div>
    {order.deliveryAddress.trim() && <div className="order-address" title={order.deliveryAddress}><MapPin size={13} /><span>{order.deliveryAddress}</span></div>}
    {onFulfilmentChange && activeStatuses.includes(order.status) && <div className="order-fulfilment" role="group" aria-label={`Fulfilment for order ${order.orderNumber}`}>
      <span className="order-fulfilment-label">{fulfilmentBusy ? "Updating…" : "Fulfilment"}</span>
      <button type="button" className={`fulfilment-option ${order.fulfilment === "pickup" ? "selected" : ""}`} aria-pressed={order.fulfilment === "pickup"} disabled={fulfilmentBusy || busy || !canPickup} title={!canPickup ? "Pickup is turned off in your business settings" : "Customer collects from your business"} onClick={() => changeFulfilment("pickup")}><Store size={14} /> Pickup</button>
      <button type="button" className={`fulfilment-option ${order.fulfilment === "delivery" ? "selected" : ""}`} aria-pressed={order.fulfilment === "delivery"} disabled={fulfilmentBusy || busy || !canDelivery} title={!canDelivery ? "Delivery is turned off in your business settings" : "Send this order for delivery"} onClick={() => changeFulfilment("delivery")}><Bike size={14} /> Delivery</button>
    </div>}
    <div className="order-divider" />
    <div className="order-items">{order.items.slice(0, 3).map((item) => <div className="order-item-line" key={item.id}><span><b>{item.quantity} ×</b> {item.name}{item.modifiers?.length ? <small className="block muted">{item.modifiers.map((modifier) => `${modifier.quantity > 1 ? `${modifier.quantity} × ` : ""}${modifier.name}`).join(", ")}</small> : null}</span></div>)}{order.items.length > 3 && <span className="muted small-text">+ {order.items.length - 3} more items</span>}</div>
    {order.customerNote && <div className="order-note">“{order.customerNote}”</div>}
    <div className="order-total"><span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items <span className="meta-dot">·</span> {paymentLabel[order.paymentStatus] ?? (order.paymentStatus === "paid" ? "Paid" : "Payment pending")}{order.paymentReference && <span className="provider-reference" title={`Payment reference ${order.paymentReference}`}> · {order.paymentReference}</span>}</span><strong>{money(order.total)}</strong></div>
    <div className="order-actions">
      {order.status === "new" && <><button className="btn btn-outline" disabled={busy} onClick={() => onAction(order, "rejected")}>Reject</button><button className="btn btn-primary" disabled={busy} onClick={() => onAction(order, "accepted")}>Accept order <ArrowRight size={16} /></button></>}
      {order.status === "accepted" && <button className="btn btn-primary full" disabled={busy} onClick={() => onAction(order, "preparing")}><ChefHat size={16} /> Start preparing</button>}
      {order.status === "preparing" && <button className="btn btn-outline full" disabled={busy} onClick={() => onAction(order, "ready")}><Check size={16} /> Mark ready</button>}
      {order.status === "ready" && order.fulfilment === "pickup" && <button className="btn btn-outline full" disabled={busy} onClick={() => onAction(order, "completed")}><ShoppingBag size={16} /> Confirm handoff</button>}
      {order.status === "ready" && order.fulfilment === "delivery" && <><div className="awaiting-delivery"><Bike size={15} /> Waiting for rider assignment</div><button className="btn btn-primary full" disabled={busy} onClick={() => onAction(order, "out_for_delivery")}><Bike size={16} /> Assign rider &amp; dispatch</button></>}
      {order.status === "out_for_delivery" && <><div className="awaiting-delivery"><Bike size={15} /> Rider is on the way</div><button className="btn btn-outline full" disabled={busy} onClick={() => onAction(order, "completed")}><Check size={16} /> Mark delivered</button></>}
      {["completed", "cancelled", "rejected"].includes(order.status) && <button className="btn btn-ghost full" onClick={() => onDetails(order)}>View details <ArrowRight size={15} /></button>}
    </div>
  </article>;
}
