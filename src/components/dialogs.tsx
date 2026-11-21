"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, ChefHat, Plus, Store, X } from "lucide-react";
import { cachedGet, clearApiCache, markApiCacheStale, refreshCached } from "@/lib/client-cache";
import type { AuthResponse, AuthUser, Business, BusinessType, MenuItem, MenuModifierGroup, Offer, OfferInput, Order } from "@/lib/types";
import { money } from "@/lib/types";
import type { OrderAction } from "@/components/order-card";

/** Only a server-marked 401 means the session expired; an upstream 401 (e.g. revoked Marketplace token) must not sign the user out. */
export const AUTH_EXPIRED_EVENT = "savour-auth-expired";
export class Api401Error extends Error {
  constructor(message: string, public readonly sessionExpired: boolean, public readonly code?: string) { super(message); }
}

export type ApiOptions = RequestInit & {
  /** Override the stale-while-revalidate window for this read. */
  cacheTtl?: number;
  /** Skip the cache entirely and do not store the response. */
  fresh?: boolean;
  /** Hit the network now and replace the cached value with the response. */
  refresh?: boolean;
  /** Do not persist this response in session storage. */
  noPersist?: boolean;
};

/** Keep signed, one-off, and auth responses out of the shared cache. */
function isCacheable(path: string) {
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/auth") || path.startsWith("/api/health")) return false;
  return !/(download|signed|export|csv|logout|\/changes|\/activate)/i.test(path);
}

function ttlFor(path: string) {
  if (path.startsWith("/api/merchant/overview") || path.startsWith("/api/merchant/orders")) return 15_000;
  if (path.startsWith("/api/compliance")) return 60_000;
  return 30_000;
}

async function fetchLive<T>(path: string, options?: ApiOptions): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith("/api/auth")) {
    const sessionExpired = response.headers.get("x-savour-auth-required") === "1";
    if (sessionExpired && typeof window !== "undefined") {
      clearApiCache();
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw new Api401Error(data.error || "Please sign in to continue.", sessionExpired, typeof data.code === "string" ? data.code : undefined);
  }
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data as T;
}

/**
 * GETs resolve from the shared client cache first, so remounted and prefetched
 * tabs never wait on a round trip. Stale entries refresh in the background.
 */
export async function api<T>(path: string, options?: ApiOptions): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  if (method === "GET" && isCacheable(path)) {
    // Compliance payloads can contain short-lived signed document links; keep
    // those in memory only so a reload never reuses an expired URL.
    const persist = !options?.noPersist && !path.startsWith("/api/merchant/compliance");
    const ttl = options?.cacheTtl ?? ttlFor(path);
    if (options?.refresh) return refreshCached<T>(path, () => fetchLive<T>(path, options), ttl, persist);
    if (!options?.fresh) return cachedGet<T>(path, () => fetchLive<T>(path, options), ttl, persist);
  }
  const result = await fetchLive<T>(path, options);
  if (!path.startsWith("/api/auth") && method !== "GET") markApiCacheStale();
  return result;
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
export function SetupModal({ initial, onClose, onBusiness, createNew = false }: { initial: Business | null; onClose: () => void; onBusiness: (business: Business) => void; createNew?: boolean }) {
  const [step, setStep] = useState<"type" | "details">(initial ? "details" : "type"), [business, setBusiness] = useState<Business | null>(initial);
  const [name, setName] = useState(initial?.name || ""), [ownerName, setOwnerName] = useState(initial?.ownerName || ""), [phone, setPhone] = useState(initial?.phone || ""), [address, setAddress] = useState(initial?.address || ""), [category, setCategory] = useState(initial?.category || ""), [registrationDetails, setRegistrationDetails] = useState(initial?.registrationDetails || "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function choose(type: BusinessType) { setBusy(true); setError(""); try { const data = await api<{ business: Business }>("/api/merchant/business", { method: "POST", body: JSON.stringify({ type, createNew }) }); setBusiness(data.business); onBusiness(data.business); setStep("details"); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  async function save(submit: boolean) {
    if (!business) return;
    const data = await api<{ business: Business }>("/api/merchant/business", { method: "PATCH", body: JSON.stringify({ action: "details", name, ownerName, phone, address, category, registrationDetails, submit }) });
    setBusiness(data.business); onBusiness(data.business);
  }
  async function finish(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await save(true); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  function close() { if (business && step === "details") void save(false).catch(() => {}); onClose(); }
  return <Modal title={createNew ? step === "type" ? "What kind of outlet is this?" : "Tell us about this outlet" : step === "type" ? "What kind of business are you?" : "Tell us about your business"} subtitle={createNew ? "Each outlet pairs to its own Marketplace listing with its own pairing code." : step === "type" ? "We’ll tailor your workspace to the way you work." : "Just the essentials for your marketplace listing."} onClose={close} wide>
    {step === "type" ? <><div className="type-options"><button className="type-option" disabled={busy} onClick={() => choose("restaurant")}><span className="type-icon"><ChefHat size={24} /></span><strong>Restaurant</strong><span>For restaurants, cafes, cloud kitchens and QSRs.</span><small>Full merchant workspace <ArrowRight size={15} /></small></button><button className="type-option" disabled={busy} onClick={() => choose("vendor")}><span className="type-icon peach"><Store size={24} /></span><strong>Street vendor</strong><span>For food carts, tea stalls and small food businesses.</span><small>A simpler way to manage orders <ArrowRight size={15} /></small></button></div>{error && <p className="form-error">{error}</p>}</> : <form onSubmit={finish} className="form-stack"><div className="form-grid"><label>Business name<input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Curry Leaf" /></label><label>Owner or representative<input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Your full name" /></label><label>Phone number<input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Your business number" /></label><label>Food category <span>(optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Indian, tea, snacks" /></label></div><label>Business address<input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, area and city" /></label><label>Food registration details <span>(optional)</span><input value={registrationDetails} onChange={(e) => setRegistrationDetails(e.target.value)} placeholder="Registration number, if applicable" /></label><div className="info-box">Your listing will be submitted for review. It won’t go live until it is approved.</div>{error && <p className="form-error">{error}</p>}<div className="modal-actions">{!createNew && <button type="button" className="btn btn-outline" onClick={() => setStep("type")}><ArrowLeft size={16} /> Back</button>}<button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Submit for review"} <ArrowRight size={16} /></button></div></form>}
  </Modal>;
}
export type MenuInput = { name: string; description: string; price: number; category: string; imageUrl: string; dietary: string; stockQuantity: number | null; modifierGroupIds: string[] };
export function MenuModal({ item, vendor, groups, onClose, onSave }: { item: MenuItem | null; vendor: boolean; groups: MenuModifierGroup[]; onClose: () => void; onSave: (input: MenuInput, id?: string) => Promise<void> }) {
  const [name, setName] = useState(item?.name || ""), [price, setPrice] = useState(item ? String(item.price / 100) : ""), [description, setDescription] = useState(item?.description || ""), [category, setCategory] = useState(item?.category || ""), [imageUrl, setImageUrl] = useState(item?.imageUrl || ""), [dietary, setDietary] = useState(item?.dietary || "unspecified");
  const [stock, setStock] = useState(item?.stockQuantity === null || item?.stockQuantity === undefined ? "" : String(item.stockQuantity)), [selectedGroups, setSelectedGroups] = useState<string[]>(item?.modifierGroupIds ?? []), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const amount = Math.round(Number(price) * 100);
      if (!Number.isFinite(amount) || amount < 100) throw new Error("Enter a valid price of at least ₹1.");
      const stockQuantity = stock.trim() === "" ? null : Number(stock);
      if (stockQuantity !== null && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 100_000)) throw new Error("Stock must be a whole number from 0 to 100000.");
      await onSave({ name, description, price: amount, category: category || "Other", imageUrl, dietary, stockQuantity, modifierGroupIds: selectedGroups }, item?.id);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={item ? "Edit menu item" : "Add a menu item"} subtitle={vendor ? "Give your item a name and price. That’s it." : "Add the details customers need to know."} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>Item name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Masala chai" /></label>
        <label>Price (₹)<input required type="number" min="1" max="100000" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" /></label>
        <label>Stock quantity <span>(optional, blank means untracked)</span><input type="number" min="0" max="100000" step="1" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="Untracked" /></label>
        {!vendor && <>
          <label>Category<input value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Mains" /></label>
          <label>Description <span>(optional)</span><textarea rows={2} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What makes this dish special?" /></label>
          <label>Dietary type<select value={dietary} onChange={(e) => setDietary(e.target.value)}><option value="unspecified">Not specified</option><option value="veg">Vegetarian</option><option value="nonveg">Non-vegetarian</option></select></label>
          <label>Image URL <span>(optional, HTTPS)</span><input type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." /></label>
        </>}
        {groups.filter((group) => group.isActive).length > 0 && <div className="form-field"><span>Variants &amp; modifiers</span><div className="group-checks">{groups.filter((group) => group.isActive).map((group) => <label key={group.id} className="group-check"><input type="checkbox" checked={selectedGroups.includes(group.id)} onChange={(e) => setSelectedGroups((current) => e.target.checked ? [...current, group.id] : current.filter((id) => id !== group.id))} /><span>{group.name}<small>{group.minSelect === group.maxSelect ? `Choose 1 of ${group.options.length}` : `Choose ${group.minSelect}–${group.maxSelect}`}</small></span></label>)}</div></div>}
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary full large" disabled={busy}>{busy ? "Saving…" : "Save item"}</button>
      </form>
    </Modal>
  );
}

export type ModifierGroupInput = { name: string; minSelect: number; maxSelect: number; isActive: boolean; options: { id?: string; name: string; priceCents: number; isVeg: boolean; available: boolean }[] };
export function ModifierGroupModal({ group, onClose, onSave }: { group: MenuModifierGroup | null; onClose: () => void; onSave: (input: ModifierGroupInput, id?: string) => Promise<void> }) {
  const [name, setName] = useState(group?.name || ""), [minSelect, setMinSelect] = useState(String(group?.minSelect ?? 0)), [maxSelect, setMaxSelect] = useState(String(group?.maxSelect ?? 1));
  type OptionDraft = { id?: string; name: string; price: string; isVeg: boolean; available: boolean };
  const [options, setOptions] = useState<OptionDraft[]>(group?.options.map((option) => ({ id: option.id, name: option.name, price: String(option.priceCents / 100), isVeg: option.isVeg, available: option.available })) ?? [{ name: "", price: "", isVeg: true, available: true }]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  function optionAt(index: number) { return options[index] ?? { name: "", price: "", isVeg: true, available: true }; }
  function patchOption(index: number, patch: Partial<typeof options[number]>) { setOptions((current) => current.map((option, i) => i === index ? { ...option, ...patch } : option)); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const min = Number(minSelect), max = Number(maxSelect);
      if (!Number.isSafeInteger(min) || min < 0 || min > 20 || !Number.isSafeInteger(max) || max < 1 || max > 20 || max < min) throw new Error("Choose valid selection limits (0–20, maximum at least the minimum).");
      const clean = options.map((option) => ({ ...(option.id ? { id: option.id } : {}), name: option.name.trim(), priceCents: Math.round(Number(option.price || 0) * 100), isVeg: option.isVeg, available: option.available }));
      if (!clean.length || clean.length > 30 || clean.some((option) => !option.name || !Number.isSafeInteger(option.priceCents) || option.priceCents < 0 || option.priceCents > 1_000_000)) throw new Error("Add between 1 and 30 options with valid prices.");
      await onSave({ name: name.trim(), minSelect: min, maxSelect: max, isActive: group?.isActive ?? true, options: clean }, group?.id);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={group ? "Edit variants & modifiers" : "Add variants & modifiers"} subtitle="One choice per customer is a variant; multiple choices are add-ons. Prices are the extra amount over the item price." onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label>Group name<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Size, Extra toppings" /></label>
        <div className="form-row"><label>Minimum choices<input required type="number" min="0" max="20" step="1" value={minSelect} onChange={(e) => setMinSelect(e.target.value)} /></label><label>Maximum choices<input required type="number" min="1" max="20" step="1" value={maxSelect} onChange={(e) => setMaxSelect(e.target.value)} /></label></div>
        <div className="form-field"><span>Options</span><div className="option-rows">{options.map((option, index) => <div className="option-row" key={index}><input required maxLength={60} value={optionAt(index).name} onChange={(e) => patchOption(index, { name: e.target.value })} placeholder="Option name" /><input required type="number" min="0" max="10000" step="0.01" value={optionAt(index).price} onChange={(e) => patchOption(index, { price: e.target.value })} placeholder="Extra ₹" /><label className="mini-check"><input type="checkbox" checked={optionAt(index).isVeg} onChange={(e) => patchOption(index, { isVeg: e.target.checked })} /> Veg</label><label className="mini-check"><input type="checkbox" checked={optionAt(index).available} onChange={(e) => patchOption(index, { available: e.target.checked })} /> Available</label><button type="button" className="icon-btn" disabled={options.length === 1} onClick={() => setOptions((current) => current.filter((_, i) => i !== index))} aria-label="Remove option"><X size={16} /></button></div>)}</div><button type="button" className="btn btn-quiet" disabled={options.length >= 30} onClick={() => setOptions((current) => [...current, { name: "", price: "", isVeg: true, available: true }])}><Plus size={15} /> Add option</button></div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary full large" disabled={busy}>{busy ? "Saving…" : "Save group"}</button>
      </form>
    </Modal>
  );
}
function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value), pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function OfferModal({ offer, onClose, onSave }: { offer: Offer | null; onClose: () => void; onSave: (input: OfferInput, id?: string) => Promise<void> }) {
  const [code, setCode] = useState(offer?.code || ""), [title, setTitle] = useState(offer?.title || ""), [description, setDescription] = useState(offer?.description || "");
  const [discountType, setDiscountType] = useState<"percent" | "flat">(offer?.discountType || "percent"), [value, setValue] = useState(offer ? String(offer.value) : "");
  const [minOrder, setMinOrder] = useState(offer ? String(offer.minOrder / 100) : ""), [maxDiscount, setMaxDiscount] = useState(offer?.maxDiscount ? String(offer.maxDiscount / 100) : "");
  const [usageLimit, setUsageLimit] = useState(offer?.usageLimit ? String(offer.usageLimit) : ""), [startsAt, setStartsAt] = useState(localDateTime(offer?.startsAt || null)), [endsAt, setEndsAt] = useState(localDateTime(offer?.endsAt || null));
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await onSave({
        code, title, description, discountType, value: Number(value),
        minOrder: minOrder ? Math.round(Number(minOrder) * 100) : 0,
        maxDiscount: discountType === "percent" && maxDiscount ? Math.round(Number(maxDiscount) * 100) : null,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        active: offer?.active ?? true,
      }, offer?.id);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <Modal title={offer ? "Edit offer" : "Create an offer"} subtitle="Customers enter the code at checkout. You choose the saving." onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <label>Offer code<input required maxLength={40} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. WELCOME20" /></label>
      <label>Offer title<input required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 20% off your first order" /></label>
      <label>Description <span>(optional)</span><textarea rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Tell customers when to use it" /></label>
      <label>Discount type<select value={discountType} onChange={(e) => setDiscountType(e.target.value as "percent" | "flat")}><option value="percent">Percentage off</option><option value="flat">Flat amount off</option></select></label>
      <label>{discountType === "percent" ? "Discount (%)" : "Discount (₹)"}<input required type="number" min={discountType === "percent" ? 1 : 1} max={discountType === "percent" ? 100 : 100000} step={discountType === "percent" ? 1 : 0.01} value={value} onChange={(e) => setValue(e.target.value)} placeholder={discountType === "percent" ? "20" : "100"} /></label>
      <label>Minimum order (₹) <span>(optional)</span><input type="number" min="0" max="100000" step="0.01" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} placeholder="No minimum" /></label>
      {discountType === "percent" && <label>Maximum discount (₹) <span>(optional)</span><input type="number" min="1" max="100000" step="0.01" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} placeholder="No cap" /></label>}
      <label>Usage limit <span>(optional)</span><input type="number" min="1" max="1000000" step="1" value={usageLimit} onChange={(e) => setUsageLimit(e.target.value)} placeholder="Unlimited" /></label>
      <div className="form-row"><label>Starts <span>(optional)</span><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label><label>Ends <span>(optional)</span><input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label></div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary full large" disabled={busy}>{busy ? "Saving…" : offer ? "Save changes" : "Create offer"}</button>
    </form>
  </Modal>;
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
  const titles: Record<OrderAction, string> = { accepted: "Accept this order?", rejected: "Reject this order?", cancelled: "Cancel this order?", preparing: "Start preparing?", ready: "Mark order ready?", out_for_delivery: "Send this order out for delivery?", completed: order.fulfilment === "delivery" ? "Confirm delivery?" : "Confirm pickup handoff?" };
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { await onConfirm(prep, reason); onClose(); } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  return <Modal title={titles[action]} subtitle={`Order #${order.orderNumber} · ${money(order.total)}`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{action === "accepted" && <label>Preparation time<select value={prep} onChange={(e) => setPrep(Number(e.target.value))}>{[10, 15, 20, 25, 30, 40, 45, 60, 90, 120].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></label>}{(action === "rejected" || action === "cancelled") && <label>{action === "rejected" ? "Reason for rejection" : "Reason for cancellation"}<textarea required maxLength={250} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === "rejected" ? "Let the customer know why you can’t fulfil this order" : "Tell the customer why this order is being cancelled"} /></label>}{action === "ready" && <p className="dialog-copy">{order.fulfilment === "delivery" ? "Marking this order ready sends it out for delivery and dispatches a rider. This does not complete the order." : "The order will be marked ready for pickup. This does not complete the order."}</p>}{action === "out_for_delivery" && <p className="dialog-copy">This assigns a rider and marks the order as out for delivery. A signed dispatch request is sent when a courier URL is configured.</p>}{action === "completed" && <p className="dialog-copy">{order.fulfilment === "delivery" ? "Only confirm once the customer has received their delivery." : "Only confirm once the customer has collected their order."}</p>}{action === "preparing" && <p className="dialog-copy">Let the customer know your kitchen has started preparing their order.</p>}{error && <p className="form-error">{error}</p>}<div className="modal-actions"><button className="btn btn-outline" type="button" onClick={onClose}>Go back</button><button className="btn btn-primary" disabled={busy}>{busy ? "Updating…" : action === "rejected" ? "Reject order" : action === "cancelled" ? "Cancel order" : action === "accepted" ? "Accept order" : action === "ready" ? "Mark ready" : action === "out_for_delivery" ? "Assign rider" : action === "completed" ? (order.fulfilment === "delivery" ? "Mark delivered" : "Confirm handoff") : "Start preparing"} <CheckCircle2 size={16} /></button></div></form></Modal>;
}
