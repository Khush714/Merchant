"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, BadgePercent, Bell, Check, CheckCircle2, ChefHat, Clock3, CreditCard, MessageCircle, Minus, Plus, ShoppingBag, Star, Store, Truck, UtensilsCrossed, X } from "lucide-react";
import { api } from "@/components/dialogs";
import { isInboxToken, newInboxToken } from "@/lib/customer-notification-copy";
import { calculateDiscount, discountLabel, isOfferLive } from "@/lib/offers";
import { money, type MenuItem, type PublicOffer } from "@/lib/types";

type Listing = { id: string; name: string; category: string; address: string; type: string; pickupEnabled?: boolean; deliveryEnabled?: boolean; accepting?: boolean; status?: "open" | "offline"; notice?: string; reopensAt?: string | null };
type CustomerFeedback = { rating: number | null; review: string; feedbackAt: string | null; merchantResponse: string; merchantRespondedAt: string | null };
type CustomerOrder = { id: string; orderNumber: number; status: string; total: number; discount: number; offerCode: string; fulfilment: string; paymentStatus: string; prepMinutes: number | null; rejectionReason: string; createdAt: string; delivery?: { state: string; reference?: string | null }; feedback: CustomerFeedback; items: { id: string; name: string; quantity: number; unitPrice: number }[] };
type CustomerNotification = { id: string; orderId: string; orderNumber: number; kind: string; title: string; body: string; readAt: string | null; createdAt: string };
type InboxResponse = { notifications: CustomerNotification[]; unreadCount: number };

/** The raw inbox token never leaves this browser; only its hash is sent to the server. */
function ensureInboxToken(): string {
  const saved = localStorage.getItem("savour-inbox");
  if (isInboxToken(saved)) return saved;
  const token = newInboxToken();
  localStorage.setItem("savour-inbox", token);
  return token;
}

function notificationIcon(kind: string) {
  if (kind === "delivery") return <Truck size={17} />;
  if (kind === "payment") return <CreditCard size={17} />;
  if (kind === "feedback_reply") return <MessageCircle size={17} />;
  return <Bell size={17} />;
}

function trackingHeadline(order: CustomerOrder): string {
  if (order.delivery?.state === "BOOKING_RECORDED") return "A delivery booking has been recorded";
  if (order.delivery?.state === "PICKED_UP") return "Your order has been collected for delivery";
  if (order.delivery?.state === "DELIVERED") return "Delivery confirmed";
  if (order.delivery?.state === "UNVERIFIED") return "Delivery status unavailable";
  if (order.status === "new") return "Waiting for the kitchen to accept";
  if (order.status === "accepted") return "Your order has been accepted";
  if (order.status === "preparing") return "Your food is being prepared";
  if (order.status === "ready") return "Your order is ready";
  if (order.status === "completed") return "Order completed";
  return `Order ${order.status}`;
}
type Pending = { businessId: string; idempotencyKey: string; customerName: string; customerNote: string; fulfilment: string; deliveryAddress: string; items: { id: string; quantity: number }[]; offerCode?: string };
export default function MarketplaceApp() {
  const [listings, setListings] = useState<Listing[]>([]), [selected, setSelected] = useState<Listing | null>(null), [items, setItems] = useState<MenuItem[]>([]), [cart, setCart] = useState<Record<string, number>>({}), [name, setName] = useState(""), [note, setNote] = useState(""), [deliveryAddress, setDeliveryAddress] = useState(""), [fulfilment, setFulfilment] = useState("pickup"), [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null), [tracking, setTracking] = useState<{ id: string; token: string } | null>(null), [order, setOrder] = useState<CustomerOrder | null>(null), [rating, setRating] = useState(0), [review, setReview] = useState(""), [feedbackBusy, setFeedbackBusy] = useState(false), [feedbackError, setFeedbackError] = useState(""), [feedbackNotice, setFeedbackNotice] = useState(""), [offers, setOffers] = useState<PublicOffer[]>([]), [offerCode, setOfferCode] = useState(""), [offerError, setOfferError] = useState(""), [inboxToken, setInboxToken] = useState(""), [inboxOpen, setInboxOpen] = useState(false), [notifications, setNotifications] = useState<CustomerNotification[]>([]), [unreadCount, setUnreadCount] = useState(0), [inboxLoading, setInboxLoading] = useState(true), [inboxBusy, setInboxBusy] = useState(false), [inboxError, setInboxError] = useState(""), [toast, setToast] = useState(""), [cartNotice, setCartNotice] = useState<{ name: string; at: number } | null>(null), [inboxReload, setInboxReload] = useState(0);
  const knownUnread = useRef<number | null>(null);
  // Restore browser-only state after hydration to keep server and initial client markup consistent.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { api<{ businesses: Listing[] }>("/api/marketplace").then((data) => setListings(data.businesses)).catch((err) => setError(err.message)).finally(() => setLoading(false)); try { const saved = localStorage.getItem("savour-order"); if (saved) setTracking(JSON.parse(saved)); const savedPending = localStorage.getItem("savour-pending-order"); if (savedPending) setPending(JSON.parse(savedPending)); } catch { /* Ignore malformed local state. */ } }, []);
  // One anonymous token groups every order placed from this browser into the same inbox.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setInboxToken(ensureInboxToken()); }, []);
  useEffect(() => {
    if (!inboxToken) return;
    let cancelled = false;
    async function load() {
      try {
        const data = await api<InboxResponse>(`/api/marketplace/notifications?token=${encodeURIComponent(inboxToken)}`);
        if (cancelled) return;
        if (knownUnread.current !== null && data.unreadCount > knownUnread.current && data.notifications[0]) {
          setToast(`${data.notifications[0].title} — ${data.notifications[0].body}`);
        }
        knownUnread.current = data.unreadCount;
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
        setInboxError("");
      } catch (err) {
        if (!cancelled) setInboxError(err instanceof Error ? err.message : "Could not load your updates.");
      } finally {
        if (!cancelled) setInboxLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden && navigator.onLine) void load(); }, 15000);
    const refresh = () => { if (!document.hidden && navigator.onLine) void load(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [inboxToken, inboxReload]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!cartNotice) return;
    const timer = window.setTimeout(() => setCartNotice(null), 1600);
    return () => clearTimeout(timer);
  }, [cartNotice]);
  async function markRead(ids: string[] | "all") {
    if (!inboxToken || inboxBusy) return;
    setInboxBusy(true); setInboxError("");
    try {
      const body = ids === "all" ? { token: inboxToken, all: true } : { token: inboxToken, ids };
      const data = await api<{ updated: number } & InboxResponse>("/api/marketplace/notifications", { method: "PATCH", body: JSON.stringify(body) });
      knownUnread.current = data.unreadCount;
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (err) { setInboxError(err instanceof Error ? err.message : "Could not update your inbox."); }
    finally { setInboxBusy(false); }
  }
  useEffect(() => { if (!tracking) return; let cancelled = false; const load = () => api<{ order: CustomerOrder }>(`/api/marketplace?orderId=${encodeURIComponent(tracking.id)}&token=${encodeURIComponent(tracking.token)}`).then((data) => { if (!cancelled) setOrder(data.order); }).catch((err) => { if (!cancelled) setError(err.message); }); void load(); const timer = window.setInterval(() => { if (!document.hidden && navigator.onLine) void load(); }, 30000); return () => { cancelled = true; clearInterval(timer); }; }, [tracking]);
  async function open(listing: Listing) { setLoading(true); setError(""); try { const data = await api<{ business: Listing; items: MenuItem[]; offers: PublicOffer[] }>(`/api/marketplace?businessId=${listing.id}`); setSelected(data.business); setItems(data.items); setOffers(data.offers ?? []); setCart({}); setOfferCode(""); setOfferError(""); setFulfilment(data.business.pickupEnabled ? "pickup" : "delivery"); } catch (err) { setError(err instanceof Error ? err.message : "Could not load menu."); } finally { setLoading(false); } }
  function change(id: string, delta: number) {
    if (pending) return;
    const currentQty = cart[id] || 0;
    const next = Math.max(0, Math.min(20, currentQty + delta));
    if (delta > 0 && next > currentQty) setCartNotice({ name: items.find((item) => item.id === id)?.name ?? "Item", at: Date.now() });
    setCart((current) => ({ ...current, [id]: Math.max(0, Math.min(20, (current[id] || 0) + delta)) }));
  }
  const cartItems = items.filter((item) => cart[item.id] > 0), total = cartItems.reduce((sum, item) => sum + item.price * cart[item.id], 0);
  const appliedOffer = offers.find((offer) => offer.code === offerCode.trim().toUpperCase() && isOfferLive(offer) && total >= offer.minOrder);
  const discount = appliedOffer ? calculateDiscount(appliedOffer, total) : 0;
  const payable = Math.max(0, total - discount);
  async function place(event: FormEvent) {
    event.preventDefault(); if (!selected && !pending) return; setBusy(true); setError("");
    const payload = pending || { businessId: selected!.id, idempotencyKey: crypto.randomUUID(), customerName: name, customerNote: note, fulfilment, deliveryAddress: fulfilment === "delivery" ? deliveryAddress : "", items: cartItems.map((item) => ({ id: item.id, quantity: cart[item.id] })), offerCode: appliedOffer?.code ?? "" };
    if (!payload.items.length) { setBusy(false); setError("Add an item to your order first."); return; }
    const requestedCode = String(payload.offerCode ?? "").trim().toUpperCase();
    if (requestedCode && !offers.some((offer) => offer.code === requestedCode && isOfferLive(offer) && total >= offer.minOrder)) { setBusy(false); setOfferError("That code needs a qualifying basket. Check the code and minimum order."); return; }
    setPending(payload); localStorage.setItem("savour-pending-order", JSON.stringify(payload));
    try {
      const inbox = inboxToken || ensureInboxToken();
      if (!inboxToken) setInboxToken(inbox);
      const data = await api<{ order: { id: string }; token: string }>("/api/marketplace", { method: "POST", body: JSON.stringify({ ...payload, inboxToken: inbox }) });
      const track = { id: data.order.id, token: data.token };
      localStorage.setItem("savour-order", JSON.stringify(track)); localStorage.removeItem("savour-pending-order"); setPending(null); setTracking(track); setSelected(null); setCart({});
      setInboxError("");
    }
    catch (err) { setError(err instanceof Error ? err.message : "Could not place order. Retry the same order safely."); } finally { setBusy(false); }
  }
  function clearPending() { if (!window.confirm("If your earlier request reached the server, starting a new order could create another order. Continue only if you’ve checked the earlier order.")) return; setPending(null); localStorage.removeItem("savour-pending-order"); }
  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    if (!tracking || feedbackBusy) return;
    // Never fail silently: a click without a rating gets an explanation next to the form.
    if (!rating) { setFeedbackError("Choose a star rating first, then rate your food."); setFeedbackNotice(""); return; }
    setFeedbackBusy(true); setFeedbackError(""); setFeedbackNotice("");
    try {
      const data = await api<{ feedback: CustomerFeedback; alreadySubmitted?: boolean }>("/api/marketplace/feedback", { method: "POST", body: JSON.stringify({ orderId: tracking.id, token: tracking.token, rating, review }) });
      setOrder((current) => current ? { ...current, feedback: data.feedback } : current);
      setFeedbackNotice(data.alreadySubmitted ? "You already rated this order — here’s what you saved." : "Thanks! Your rating and review have been saved.");
      setRating(0); setReview("");
    } catch (err) { setFeedbackError(err instanceof Error ? err.message : "Could not submit your feedback."); }
    finally { setFeedbackBusy(false); }
  }
  return <div className="marketplace-shell"><header className="market-header"><Link className="market-brand" href="/"><span className="brand-mark"><UtensilsCrossed size={19} /></span><strong>savour<span>.</span></strong></Link><div className="market-header-actions"><button className="inbox-bell" aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`} aria-expanded={inboxOpen} onClick={() => setInboxOpen((open) => !open)}><Bell size={19} />{unreadCount > 0 && <span className="inbox-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}</button><div><Link href="/">Merchant workspace <ArrowRight size={15} /></Link></div></div></header><main className="market-content"><div className="market-intro"><div className="eyebrow">GOOD FOOD, GOOD PEOPLE <span>✳</span></div><h1>Made nearby, just for you.</h1><p>Discover food from local kitchens and neighbourhood favourites.</p></div>{error && <div className="approval-banner"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}
    {pending && <div className="setup-banner"><div><strong>An order request is waiting to be confirmed.</strong><span>Retry the exact same request safely. Do not create another order unless you’ve checked the first one.</span></div><div className="pending-actions"><button className="btn btn-outline" onClick={clearPending}>Start over</button><button className="btn btn-primary" disabled={busy} onClick={(event) => void place(event)}>{busy ? "Checking…" : "Retry order"}</button></div></div>}
    {tracking && order && <div className="panel tracking-card"><div className="tracking-icon"><CheckCircle2 size={22} /></div><div><span className="eyebrow">YOUR LATEST ORDER · #{order.orderNumber}</span><h3>{trackingHeadline(order)}</h3><p>{money(order.total)} · {order.fulfilment} · {order.paymentStatus === "paid" ? "Paid" : "Payment pending"}{order.discount > 0 ? ` · ${money(order.discount)} saved with ${order.offerCode}` : ""}{order.prepMinutes ? ` · ${order.prepMinutes} min prep` : ""}{order.rejectionReason ? ` · ${order.rejectionReason}` : ""}</p></div><button className="icon-button" aria-label="Dismiss tracking" onClick={() => { setTracking(null); setOrder(null); localStorage.removeItem("savour-order"); }}>×</button></div>}
    {tracking && order && order.status === "completed" && (
      <div className="panel customer-feedback">
        {order.feedback?.feedbackAt ? (
          <div className="feedback-done">
            <div className="feedback-stars">{"★".repeat(order.feedback.rating ?? 0)}{"☆".repeat(5 - (order.feedback.rating ?? 0))}</div>
            <strong>Thanks for sharing your feedback.</strong>
            {order.feedback.review && <p className="customer-review">“{order.feedback.review}”</p>}
            {order.feedback.merchantResponse && <p><strong>The kitchen replied:</strong> {order.feedback.merchantResponse}</p>}
          </div>
        ) : (
          <form onSubmit={submitFeedback}>
            <strong>How was your order?</strong>
            <p>Your rating helps this kitchen improve.</p>
            <div className="customer-stars" role="group" aria-label="Rating from 1 to 5 stars">
              {[1, 2, 3, 4, 5].map((value) => (
                <button type="button" key={value} className={value <= rating ? "selected" : ""} aria-label={`${value} star${value === 1 ? "" : "s"}`} aria-pressed={value === rating} onClick={() => { setRating(value); setFeedbackError(""); }}>
                  <Star size={24} fill={value <= rating ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
            <span className="rating-hint" aria-live="polite">{rating ? `${rating} of 5 · ${["", "Poor", "Fair", "Good", "Great", "Excellent"][rating]}` : "Select a star rating"}</span>
            <textarea maxLength={500} rows={3} value={review} onChange={(event) => setReview(event.target.value)} placeholder="Anything else you’d like them to know? (optional)" />
            {feedbackError && <p className="feedback-error" role="alert">{feedbackError}</p>}
            {feedbackNotice && <p className="feedback-notice" role="status">{feedbackNotice}</p>}
            <button type="submit" className="btn btn-primary" disabled={feedbackBusy}>{feedbackBusy ? "Saving your rating…" : "Rate food"}</button>
          </form>
        )}
      </div>
    )}
    {!selected ? <><div className="market-section-heading"><div><h2>Places near you</h2><p>Approved kitchens. Closed ones stay visible and show as offline.</p></div><span>{listings.length} places</span></div>{loading ? <div className="empty-state">Loading businesses…</div> : listings.length ? <div className="listing-grid">{listings.map((listing) => <button className="panel listing-card" key={listing.id} onClick={() => open(listing)}><div className="listing-art"><ChefHat size={34} />{listing.accepting === false ? <span className="closed">OFFLINE</span> : <span>OPEN NOW</span>}</div><div className="listing-body"><h3>{listing.name}</h3><p>{listing.category || "Local food"} · {listing.address}</p>{listing.accepting === false && <p className="listing-offline-note">{listing.notice || "Not accepting orders right now"}</p>}<strong>View menu <ArrowRight size={15} /></strong></div></button>)}</div> : <div className="empty-state"><span><Store size={25} /></span><strong>No approved businesses yet</strong><p>Approved kitchens will appear here, even when they’re offline.</p><Link href="/" className="btn btn-outline">Are you a food business?</Link></div>}</> : <><button className="back-link" onClick={() => { setSelected(null); setCart({}); }}><ArrowLeft size={16} /> All businesses</button><div className="market-section-heading"><div><h2>{selected.name}</h2><p>{selected.category} · {selected.address}</p></div><span className={`online-badge ${selected.accepting === false ? "closed" : ""}`}><span /> {selected.accepting === false ? "OFFLINE" : "OPEN"}</span></div><div className="market-columns"><div className="market-items">{items.length ? items.map((item) => <div className="panel market-item" key={item.id}><div>{item.dietary !== "unspecified" && <span className={`diet-mark ${item.dietary}`} /> }<h3>{item.name}</h3><strong>{money(item.price)}</strong><p>{item.description}</p></div><div>{item.imageUrl && <Image src={item.imageUrl} alt="" width={70} height={70} unoptimized />}<div className="quantity-control"><button disabled={!!pending || !cart[item.id] || selected.accepting === false} onClick={() => change(item.id, -1)} aria-label={`Remove ${item.name}`}><Minus size={15} /></button><span>{cart[item.id] || 0}</span><button disabled={!!pending || selected.accepting === false} onClick={() => change(item.id, 1)} aria-label={`Add ${item.name}`}><Plus size={15} /></button></div></div></div>) : <div className="empty-state"><span><ChefHat size={25} /></span><strong>No items available right now</strong><p>Check back with this kitchen later.</p></div>}</div><form className="panel cart-panel" onSubmit={place}><div className="section-heading"><div><h3>Your order</h3><p>Fresh from {selected.name}</p></div><span className="settings-icon"><ShoppingBag size={20} /></span></div>{selected.accepting === false && <div className="approval-banner"><span>{selected.notice || "This kitchen is not accepting new orders right now."}</span></div>}{offers.length > 0 && <div className="cart-offers"><div className="cart-offers-head"><BadgePercent size={16} /><strong>Available offers</strong></div><div className="cart-offer-list">{offers.map((offer) => <button type="button" key={offer.code} className={`cart-offer ${appliedOffer?.code === offer.code ? "selected" : ""}`} disabled={!!pending} onClick={() => { setOfferCode(appliedOffer?.code === offer.code ? "" : offer.code); setOfferError(""); }}><span><strong>{offer.code}</strong><small>{offer.title}{offer.minOrder ? ` · Min ${money(offer.minOrder)}` : ""}</small></span><em>{discountLabel(offer)}</em></button>)}</div><label className="offer-code-input">Have a code?<input value={offerCode} maxLength={40} onChange={(event) => { setOfferCode(event.target.value.toUpperCase()); setOfferError(""); }} placeholder="Enter code" disabled={!!pending} /></label>{offerError && <p className="feedback-error" role="alert">{offerError}</p>}{offerCode && !appliedOffer && !offerError && <p className="feedback-error" role="alert">This code needs a qualifying basket.</p>}</div>}{cartItems.length ? <>{cartItems.map((item) => <div className="earnings-line" key={item.id}><span>{cart[item.id]} × {item.name}</span><strong>{money(cart[item.id] * item.price)}</strong></div>)}{discount > 0 && <div className="earnings-line discount"><span>Offer {appliedOffer?.code}</span><strong>−{money(discount)}</strong></div>}<div className="earnings-line total"><span>{discount > 0 ? "To pay" : "Total"}</span><strong>{money(payable)}</strong></div><label>Your name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Name for the order" disabled={!!pending} /></label><label>Fulfilment<select value={fulfilment} onChange={(e) => setFulfilment(e.target.value)} disabled={!!pending}>{selected.pickupEnabled && <option value="pickup">Pickup</option>}{selected.deliveryEnabled && <option value="delivery">Delivery</option>}</select></label>{fulfilment === "delivery" && <label>Delivery address<textarea required rows={2} maxLength={300} value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Street, area and city" disabled={!!pending} /></label>}<label>Instructions <span>(optional)</span><textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Any special requests?" disabled={!!pending} /></label><div className="info-box">Payment is recorded as unpaid. Arrange cash payment with the business; no online payment is collected here.</div>{cartNotice && <div className="cart-toast" role="status" aria-live="polite"><CheckCircle2 size={15} /><span><strong>Added to cart</strong> · {cartNotice.name}</span></div>}<button className="btn btn-primary full large" disabled={busy || !!pending || selected.accepting === false}>{busy ? "Placing order…" : "Place order"} <ArrowRight size={16} /></button></> : <div className="settlement-empty"><Clock3 size={23} /><strong>Your basket is empty</strong><span>Add an item from the menu to get started.</span></div>}</form></div></>}
    {inboxOpen && (
      <div className="inbox-backdrop" onClick={() => setInboxOpen(false)}>
        <section className="panel inbox-panel" role="dialog" aria-modal="true" aria-labelledby="inbox-title" onClick={(event) => event.stopPropagation()}>
          <div className="inbox-head">
            <div><span className="eyebrow">YOUR UPDATES</span><h2 id="inbox-title">Notifications</h2><p>Order, delivery and payment updates from this browser.</p></div>
            <button className="icon-button" aria-label="Close notifications" onClick={() => setInboxOpen(false)}><X size={18} /></button>
          </div>
          <div className="inbox-tools">
            <span>{unreadCount} unread</span>
            {unreadCount > 0 && <button className="btn btn-outline" disabled={inboxBusy} onClick={() => void markRead("all")}><Check size={15} /> Mark all read</button>}
          </div>
          {inboxError && <div className="inbox-error" role="alert"><span>{inboxError}</span><button onClick={() => { setInboxLoading(true); setInboxReload((value) => value + 1); }}>Retry</button></div>}
          <div className="inbox-list">
            {inboxLoading && !notifications.length ? <div className="inbox-empty">Loading updates…</div> : notifications.length ? notifications.map((item) => (
              <div className={`inbox-row${item.readAt ? "" : " unread"}`} key={item.id}>
                <span className="inbox-row-icon">{notificationIcon(item.kind)}</span>
                <div className="inbox-row-body">
                  <div className="inbox-row-top"><strong>{item.title}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
                  <p>{item.body}</p>
                  <span className="inbox-row-meta">Order #{item.orderNumber}</span>
                </div>
                {!item.readAt && <button className="inbox-mark" disabled={inboxBusy} aria-label={`Mark ${item.title} as read`} onClick={() => void markRead([item.id])}><Check size={15} /></button>}
              </div>
            )) : <div className="inbox-empty"><span><Bell size={25} /></span><strong>No updates yet</strong><p>Place an order and its updates will show up here.</p></div>}
          </div>
          <p className="inbox-footnote">Private to this browser. No account or contact details needed.</p>
        </section>
      </div>
    )}
    {toast && <div className="inbox-toast" role="status"><span className="inbox-toast-icon"><Bell size={17} /></span><div><strong>New update</strong><span>{toast}</span></div><button aria-label="Dismiss notification" onClick={() => setToast("")}><X size={15} /></button></div>}
    </main></div>;
}
