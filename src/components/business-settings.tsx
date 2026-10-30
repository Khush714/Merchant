"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Clock3, Link2, MapPin, RefreshCw, ShieldCheck, Store, Unplug } from "lucide-react";
import { api } from "@/components/dialogs";
import type { Business } from "@/lib/types";

export function BusinessSettings({ business, onSave }: { business: Business; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  const [name, setName] = useState(business.name), [ownerName, setOwnerName] = useState(business.ownerName), [phone, setPhone] = useState(business.phone), [address, setAddress] = useState(business.address), [category, setCategory] = useState(business.category), [registrationDetails, setRegistrationDetails] = useState(business.registrationDetails);
  const [hoursEnabled, setHoursEnabled] = useState(business.hoursEnabled), [opensAt, setOpensAt] = useState(business.opensAt), [closesAt, setClosesAt] = useState(business.closesAt), [pickupEnabled, setPickupEnabled] = useState(business.pickupEnabled), [deliveryEnabled, setDeliveryEnabled] = useState(business.deliveryEnabled), [busy, setBusy] = useState(""), [message, setMessage] = useState("");
  async function save(event: FormEvent, action: "details" | "settings") { event.preventDefault(); setBusy(action); setMessage(""); try { await onSave(action === "details" ? { action, name, ownerName, phone, address, category, registrationDetails } : { action, hoursEnabled, opensAt, closesAt, pickupEnabled, deliveryEnabled }); setMessage("Changes saved."); } catch (err) { setMessage(err instanceof Error ? err.message : "Could not save changes."); } finally { setBusy(""); } }
  return <div className="settings-layout"><div className="settings-main"><form className="panel settings-panel" onSubmit={(event) => save(event, "details")}><div className="section-heading"><div><h3>Business profile</h3><p>The details associated with your marketplace listing.</p></div><span className="settings-icon"><Store size={19} /></span></div><div className="form-grid"><label>Business name<input required value={name} onChange={(e) => setName(e.target.value)} /></label><label>Owner or representative<input required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} /></label><label>Phone number<input required value={phone} onChange={(e) => setPhone(e.target.value)} /></label><label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} /></label></div><label>Address<input required value={address} onChange={(e) => setAddress(e.target.value)} /></label><label>Registration details<input value={registrationDetails} onChange={(e) => setRegistrationDetails(e.target.value)} /></label><button className="btn btn-primary" disabled={!!busy}>{busy === "details" ? "Saving…" : "Save profile"}</button></form>
    <form className="panel settings-panel" onSubmit={(event) => save(event, "settings")}><div className="section-heading"><div><h3>Hours & fulfilment</h3><p>Set a daily schedule in India Standard Time.</p></div><span className="settings-icon"><Clock3 size={19} /></span></div><label className="check-row"><input type="checkbox" checked={hoursEnabled} onChange={(e) => setHoursEnabled(e.target.checked)} /> Enforce daily operating hours</label><div className="form-grid"><label>Opens at<input type="time" required value={opensAt} onChange={(e) => setOpensAt(e.target.value)} /></label><label>Closes at<input type="time" required value={closesAt} onChange={(e) => setClosesAt(e.target.value)} /></label></div><div className="check-list"><label className="check-row"><input type="checkbox" checked={pickupEnabled} onChange={(e) => setPickupEnabled(e.target.checked)} /> Customer pickup</label><label className="check-row"><input type="checkbox" checked={deliveryEnabled} onChange={(e) => setDeliveryEnabled(e.target.checked)} /> Delivery</label></div>{deliveryEnabled && <div className="info-box">Arrange your own delivery. Delivery completion requires a connected delivery service and is not confirmed by marking an order ready.</div>}<button className="btn btn-primary" disabled={!!busy}>{busy === "settings" ? "Saving…" : "Save hours"}</button></form>{message && <p className="settings-message" role="status">{message}</p>}<MarketplaceConnection /></div><aside className="panel settings-aside"><span className="settings-icon"><ShieldCheck size={21} /></span><h3>Listing status</h3><span className={`approval-tag approval-${business.approvalStatus}`}>{business.approvalStatus === "approved" ? "Approved" : business.approvalStatus === "pending" ? "Pending review" : business.approvalStatus === "draft" ? "Setup incomplete" : "Not approved"}</span><p>Only approved and open businesses are visible to customers. Your existing orders are never cancelled when you close.</p><div className="side-note"><MapPin size={17} /> Marketplace availability is also checked against your operating hours.</div></aside></div>;
}


type MarketplaceLinkState = { linked: boolean; restaurant: { id: number; name: string; slug: string } | null; connectedAt?: string | null };
function MarketplaceConnection() {
  const [link, setLink] = useState<MarketplaceLinkState>({ linked: false, restaurant: null });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setLink(await api<MarketplaceLinkState>("/api/merchant/marketplace-link")); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load Marketplace connection."); }
    finally { setLoading(false); }
  }, []);
  // Load the current pair state on mount; setState calls resolve after the request settles.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);
  async function connect(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const result = await api<MarketplaceLinkState>("/api/merchant/marketplace-link", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
      setLink(result); setCode(""); window.dispatchEvent(new Event("savour-marketplace-link-changed")); setMessage("Marketplace connected. Menu and orders will now use the Marketplace records.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not connect Marketplace."); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm("Disconnect this business from the Marketplace? New Marketplace orders will no longer appear here.")) return;
    setBusy(true); setMessage("");
    try { await api("/api/merchant/marketplace-link", { method: "DELETE" }); setLink({ linked: false, restaurant: null }); window.dispatchEvent(new Event("savour-marketplace-link-changed")); setMessage("Marketplace disconnected."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not disconnect Marketplace."); }
    finally { setBusy(false); }
  }
  return <section className="panel settings-panel">
    <div className="section-heading"><div><h3>Marketplace connection</h3><p>Connect this workspace to the canonical Savour Marketplace listing.</p></div><span className="settings-icon"><Link2 size={19} /></span></div>
    {loading ? <p className="dialog-copy">Checking connection…</p> : link.linked && link.restaurant ? <><div className="info-box"><strong>{link.restaurant.name}</strong><br />Connected listing: <span>{link.restaurant.slug}</span><br /><span>Menus and orders are managed by the Marketplace backend.</span></div><button type="button" className="btn btn-outline" disabled={busy} onClick={disconnect}><Unplug size={16} /> {busy ? "Disconnecting…" : "Disconnect Marketplace"}</button></> : <form className="form-stack" onSubmit={connect}><p className="dialog-copy">In your Marketplace partner console, open <strong>Merchant App</strong>, generate a one-time pairing code, and paste it here. The code expires after 10 minutes.</p><label>One-time pairing code<input required minLength={24} maxLength={128} autoComplete="off" value={code} onChange={(event) => setCode(event.target.value.trim())} placeholder="Paste pairing code" /></label><button className="btn btn-primary" disabled={busy || !code.trim()}><Link2 size={16} /> {busy ? "Connecting…" : "Connect Marketplace"}</button><button type="button" className="btn btn-outline" disabled={loading || busy} onClick={() => { setLoading(true); void refresh(); }}><RefreshCw size={15} /> Refresh connection</button></form>}
    {message && <p className="settings-message" role="status">{message}</p>}
  </section>;
}
