"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ChefHat, Store, X } from "lucide-react";
import type { AuthResponse, AuthUser, Business, BusinessType, MenuItem, Order } from "@/lib/types";
import { money } from "@/lib/types";
import type { OrderAction } from "@/components/order-card";

/** Only a server-marked 401 means the session expired; an upstream 401 (e.g. revoked Marketplace token) must not sign the user out. */
export const AUTH_EXPIRED_EVENT = "savour-auth-expired";
export class Api401Error extends Error {
  constructor(message: string, public readonly sessionExpired: boolean) { super(message); }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith("/api/auth")) {
    const sessionExpired = response.headers.get("x-savour-auth-required") === "1";
    if (sessionExpired && typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    throw new Api401Error(data.error || "Please sign in to continue.", sessionExpired);
  }
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data as T;
}
export function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? "modal-wide" : ""}`}>
    <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={20} /></button></div>{children}
  </section></div>;
}
export function AccountModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (data: AuthResponse & { user: AuthUser }) => void }) {
  const [mode, setMode] = useState<"register" | "login" | "forgot">("register"), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (mode === "forgot") {
        const data = await api<{ ok: boolean; sent: boolean; configured: boolean }>("/api/auth", { method: "POST", body: JSON.stringify({ action: "forgot-password", email }) });
        setMessage(data.configured ? data.sent ? "If that email is registered, we’ve sent a reset link." : "We couldn’t send the email. Please try again later." : "Email delivery isn’t configured in this environment.");
      } else {
        onSuccess(await api<AuthResponse & { user: AuthUser }>("/api/auth", { method: "POST", body: JSON.stringify({ action: mode, email, password }) }));
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); }
  }
  const forgot = mode === "forgot";
  return <Modal title={forgot ? "Reset your password" : mode === "register" ? "Let’s get you set up" : "Welcome back"} subtitle={forgot ? "We’ll email you a link to choose a new password." : mode === "register" ? "Create your merchant account to get started." : "Sign in to your merchant workspace."} onClose={onClose}>
    <form onSubmit={submit} className="form-stack"><label>Email address<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" /></label>{!forgot && <label>Password<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" /></label>}{error && <p className="form-error">{error}</p>}{message && <p className="info-box">{message}</p>}<button className="btn btn-primary full large" disabled={busy}>{busy ? "Please wait…" : forgot ? "Send reset link" : mode === "register" ? "Create account" : "Sign in"} <ArrowRight size={17} /></button></form>
    <p className="modal-bottom">{forgot ? "Remembered your password?" : mode === "register" ? "Already have an account?" : "New to Savour?"} <button onClick={() => { setMode(forgot ? "login" : mode === "register" ? "login" : "register"); setError(""); setMessage(""); }}>{forgot ? "Back to sign in" : mode === "register" ? "Sign in" : "Create account"}</button></p>
    {!forgot && <p className="modal-bottom"><button onClick={() => { setMode("forgot"); setError(""); setMessage(""); }}>Forgot password?</button></p>}
  </Modal>;
}
export function PasswordModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [currentPassword, setCurrentPassword] = useState(""), [newPassword, setNewPassword] = useState(""), [confirmPassword, setConfirmPassword] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (newPassword !== confirmPassword) { setError("The new passwords do not match."); return; }
    if (newPassword === currentPassword) { setError("Choose a new password different from your current one."); return; }
    setBusy(true);
    try { await api("/api/auth", { method: "POST", body: JSON.stringify({ action: "change-password", currentPassword, newPassword }) }); onSuccess(); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <Modal title="Change password" subtitle="Your other devices will be signed out." onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <label>Current password<input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
      <label>New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="At least 8 characters" /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary full large" disabled={busy}>{busy ? "Updating…" : "Change password"}</button>
    </form>
  </Modal>;
}
export function SetupModal({ initial, onClose, onBusiness }: { initial: Business | null; onClose: () => void; onBusiness: (business: Business) => void }) {
  const [step, setStep] = useState<"type" | "details">(initial ? "details" : "type"), [business, setBusiness] = useState<Business | null>(initial);
  const [name, setName] = useState(initial?.name || ""), [ownerName, setOwnerName] = useState(initial?.ownerName || ""), [phone, setPhone] = useState(initial?.phone || ""), [address, setAddress] = useState(initial?.address || ""), [category, setCategory] = useState(initial?.category || ""), [registrationDetails, setRegistrationDetails] = useState(initial?.registrationDetails || "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function choose(type: BusinessType) { setBusy(true); setError(""); try { const data = await api<{ business: Business }>("/api/merchant/business", { method: "POST", body: JSON.stringify({ type }) }); setBusiness(data.business); onBusiness(data.business); setStep("details"); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  async function save(submit: boolean) {
    if (!business) return;
    const data = await api<{ business: Business }>("/api/merchant/business", { method: "PATCH", body: JSON.stringify({ action: "details", name, ownerName, phone, address, category, registrationDetails, submit }) });
    setBusiness(data.business); onBusiness(data.business);
  }
  async function finish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await save(true); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  function close() { if (business && step === "details") void save(false).catch(() => {}); onClose(); }
  return <Modal title={step === "type" ? "What kind of business are you?" : "Tell us about your business"} subtitle={step === "type" ? "We’ll tailor your workspace to the way you work." : "Just the essentials for your marketplace listing."} onClose={close} wide>
    {step === "type" ? <><div className="type-options"><button className="type-option" disabled={busy} onClick={() => choose("restaurant")}><span className="type-icon"><ChefHat size={24} /></span><strong>Restaurant</strong><span>For restaurants, cafes, cloud kitchens and QSRs.</span><small>Full merchant workspace <ArrowRight size={15} /></small></button><button className="type-option" disabled={busy} onClick={() => choose("vendor")}><span className="type-icon peach"><Store size={24} /></span><strong>Street vendor</strong><span>For food carts, tea stalls and small food businesses.</span><small>A simpler way to manage orders <ArrowRight size={15} /></small></button></div>{error && <p className="form-error">{error}</p>}</> : <form onSubmit={finish} className="form-stack"><div className="form-grid"><label>Business name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Curry Leaf" /></label><label>Owner or representative<input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Your full name" /></label><label>Phone number<input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Your business number" /></label><label>Food category <span>(optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Indian, tea, snacks" /></label></div><label>Business address<input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, area and city" /></label><label>Food registration details <span>(optional)</span><input value={registrationDetails} onChange={(e) => setRegistrationDetails(e.target.value)} placeholder="Registration number, if applicable" /></label><div className="info-box">Your listing will be submitted for review. It won’t go live until it is approved.</div>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="btn btn-outline" onClick={() => setStep("type")}><ArrowLeft size={16} /> Back</button><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Submit for review"} <ArrowRight size={16} /></button></div></form>}
  </Modal>;
}
export type MenuInput = { name: string; description: string; price: number; category: string; imageUrl: string; dietary: string };
export function MenuModal({ item, vendor, onClose, onSave }: { item: MenuItem | null; vendor: boolean; onClose: () => void; onSave: (input: MenuInput, id?: string) => Promise<void> }) {
  const [name, setName] = useState(item?.name || ""), [price, setPrice] = useState(item ? String(item.price / 100) : ""), [description, setDescription] = useState(item?.description || ""), [category, setCategory] = useState(item?.category || ""), [imageUrl, setImageUrl] = useState(item?.imageUrl || ""), [dietary, setDietary] = useState(item?.dietary || "unspecified"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const amount = Math.round(Number(price) * 100); if (!Number.isFinite(amount) || amount < 100) throw new Error("Enter a valid price of at least ₹1."); await onSave({ name, description, price: amount, category: category || "Other", imageUrl, dietary }, item?.id); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  return <Modal title={item ? "Edit menu item" : "Add a menu item"} subtitle={vendor ? "Give your item a name and price. That’s it." : "Add the details customers need to know."} onClose={onClose}><form className="form-stack" onSubmit={submit}><label>Item name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Masala chai" /></label><label>Price (₹)<input required type="number" min="1" max="100000" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" /></label>{!vendor && <><label>Category<input value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Mains" /></label><label>Description <span>(optional)</span><textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What makes this dish special?" /></label><label>Dietary type<select value={dietary} onChange={(e) => setDietary(e.target.value)}><option value="unspecified">Not specified</option><option value="veg">Vegetarian</option><option value="nonveg">Non-vegetarian</option></select></label><label>Image URL <span>(optional, HTTPS)</span><input type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." /></label></>}{error && <p className="form-error">{error}</p>}<button className="btn btn-primary full large" disabled={busy}>{busy ? "Saving…" : "Save item"}</button></form></Modal>;
}
export function FulfilmentModal({ order, fulfilment, onClose, onConfirm }: { order: Order; fulfilment: "pickup" | "delivery"; onClose: () => void; onConfirm: (addressText?: string) => Promise<void> }) {
  const [address, setAddress] = useState(order.deliveryAddress || ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const needsAddress = fulfilment === "delivery" && !order.deliveryAddress.trim();
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await onConfirm(needsAddress ? address.trim() : undefined); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <Modal title={fulfilment === "delivery" ? "Switch to delivery?" : "Switch to pickup?"} subtitle={`Order #${order.orderNumber} · ${money(order.total)}`} onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      {needsAddress
        ? <label>Delivery address<textarea required maxLength={500} rows={3} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, area, landmark and phone number" /></label>
        : <p className="dialog-copy">{fulfilment === "pickup" ? "The customer will collect this order from your business." : `Deliver this order to ${order.deliveryAddress}.`}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button className="btn btn-outline" type="button" onClick={onClose}>Go back</button><button className="btn btn-primary" disabled={busy}>{busy ? "Updating…" : `Switch to ${fulfilment}`} <CheckCircle2 size={16} /></button></div>
    </form>
  </Modal>;
}
export function DecisionModal({ order, action, onClose, onConfirm }: { order: Order; action: OrderAction; onClose: () => void; onConfirm: (prepMinutes: number, reason: string) => Promise<void> }) {
  const [prep, setPrep] = useState(20), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const titles: Record<OrderAction, string> = { accepted: "Accept this order?", rejected: "Reject this order?", preparing: "Start preparing?", ready: "Mark order ready?", out_for_delivery: "Send this order out for delivery?", completed: order.fulfilment === "delivery" ? "Confirm delivery?" : "Confirm pickup handoff?" };
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await onConfirm(prep, reason); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  return <Modal title={titles[action]} subtitle={`Order #${order.orderNumber} · ${money(order.total)}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{action === "accepted" && <label>Preparation time<select value={prep} onChange={(e) => setPrep(Number(e.target.value))}>{[10, 15, 20, 25, 30, 40, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></label>}{action === "rejected" && <label>Reason for rejection<textarea required maxLength={250} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Let the customer know why you can’t fulfil this order" /></label>}{action === "ready" && <p className="dialog-copy">The order will be marked ready for {order.fulfilment}. This does not complete the order.</p>}{action === "out_for_delivery" && <p className="dialog-copy">This assigns a rider and marks the order as out for delivery. No courier service is connected in this workspace, so dispatch and delivery are advanced manually.</p>}{action === "completed" && <p className="dialog-copy">{order.fulfilment === "delivery" ? "Only confirm once the customer has received their delivery." : "Only confirm once the customer has collected their order."}</p>}{action === "preparing" && <p className="dialog-copy">Let the customer know your kitchen has started preparing their order.</p>}{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="btn btn-outline" type="button" onClick={onClose}>Go back</button><button className="btn btn-primary" disabled={busy}>{busy ? "Updating…" : action === "rejected" ? "Reject order" : action === "accepted" ? "Accept order" : action === "ready" ? "Mark ready" : action === "out_for_delivery" ? "Assign rider" : action === "completed" ? (order.fulfilment === "delivery" ? "Mark delivered" : "Confirm handoff") : "Start preparing"} <CheckCircle2 size={16} /></button></div></form></Modal>;
}
