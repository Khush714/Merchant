"use client";
import { useState, type FormEvent } from "react";
import { Check, ChevronDown, Clock3, MapPin, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { ServiceMap } from "@/components/service-map";
import { defaultWeeklyHours, MAX_DELIVERY_RADIUS_METERS, MIN_DELIVERY_RADIUS_METERS } from "@/lib/service-config";
import { money, type Business, type DayPart, type DeliveryZone, type MenuItem, type ServicePoint, type WeeklyDayHours } from "@/lib/types";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const emptyPart = (): DayPart => ({
  id: crypto.randomUUID(), name: "", opensAt: "09:00", closesAt: "17:00", days: [], itemIds: [], active: true,
});

type Props = {
  business: Business;
  items: MenuItem[];
  onSave: (payload: Record<string, unknown>) => Promise<void>;
};

export function ServiceSettings({ business, items, onSave }: Props) {
  const [point, setPoint] = useState<ServicePoint | null>(
    business.latitude !== null && business.latitude !== undefined && business.longitude !== null && business.longitude !== undefined
      ? { latitude: business.latitude, longitude: business.longitude } : null,
  );
  const [radius, setRadius] = useState(business.deliveryRadiusMeters ?? 3000);
  const [zones, setZones] = useState<DeliveryZone[]>(business.deliveryZones ?? []);
  const [focus, setFocus] = useState<ServicePoint | null>(null);
  const [weekly, setWeekly] = useState<WeeklyDayHours[]>(
    business.weeklyHours?.length === 7 ? business.weeklyHours : defaultWeeklyHours(business),
  );
  const [parts, setParts] = useState<DayPart[]>(business.dayParts ?? []);
  const [draft, setDraft] = useState<DayPart | null>(null);
  const [busy, setBusy] = useState(""), [message, setMessage] = useState(""), [zonesOpen, setZonesOpen] = useState(false);

  async function save(action: string, payload: Record<string, unknown>, success: string) {
    setBusy(action); setMessage("");
    try { await onSave({ action, ...payload }); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save changes."); }
    finally { setBusy(""); }
  }

  function addZone() {
    if (!point) return;
    setZones((current) => [...current, {
      id: crypto.randomUUID(), name: `Zone ${current.length + 1}`,
      latitude: point.latitude, longitude: point.longitude, radiusMeters: radius,
    }]);
    setZonesOpen(true);
  }
  function patchZone(id: string, patch: Partial<DeliveryZone>) {
    setZones((current) => current.map((zone) => zone.id === id ? { ...zone, ...patch } : zone));
  }
  function toggleDay(id: number) {
    setDraft((current) => current ? {
      ...current,
      days: current.days.includes(id) ? current.days.filter((day) => day !== id) : [...current.days, id].sort((a, b) => a - b),
    } : current);
  }
  function toggleItem(id: string) {
    setDraft((current) => current ? {
      ...current,
      itemIds: current.itemIds.includes(id) ? current.itemIds.filter((itemId) => itemId !== id) : [...current.itemIds, id],
    } : current);
  }
  function savePart(event: FormEvent) {
    event.preventDefault();
    if (!draft?.name.trim()) return;
    const next = { ...draft, name: draft.name.trim() };
    setParts((current) => current.some((part) => part.id === next.id)
      ? current.map((part) => part.id === next.id ? next : part) : [...current, next]);
    setDraft(null);
  }
  function describeDays(value: number[]) { return value.length ? value.slice().sort((a, b) => a - b).map((day) => DAY_LABELS[day].slice(0, 3)).join(" · ") : "Every day"; }

  return <div className="service-layout">
    <section className="panel service-panel">
      <div className="section-heading"><div><h3>Location &amp; delivery area</h3><p>Drop a pin for your outlet and set how far you deliver.</p></div><span className="settings-icon"><MapPin size={19} /></span></div>
      <ServiceMap key={focus ? `${focus.latitude},${focus.longitude}` : "pin"} point={point} radiusMeters={radius} zones={zones} focus={focus} onPick={setPoint} />
      <p className="service-hint">Click to place the pin, drag to move around the map. Tiles by OpenStreetMap contributors.</p>
      <div className="service-row">
        <div className="service-readout"><span>Outlet pin</span><strong>{point ? `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}` : "Not set"}</strong></div>
        {point && <button type="button" className="btn btn-quiet" onClick={() => setPoint(null)}>Clear pin</button>}
      </div>
      <label className="service-range"><span><span>Default delivery radius</span><strong>{(radius / 1000).toFixed(2)} km</strong></span>
        <input type="range" min={MIN_DELIVERY_RADIUS_METERS} max={MAX_DELIVERY_RADIUS_METERS} step={250} value={radius} onChange={(event) => setRadius(Number(event.target.value))} />
      </label>
      <div className="service-actions">
        <button type="button" className="btn btn-primary" disabled={!!busy || !point} onClick={() => void save("location", { latitude: point?.latitude, longitude: point?.longitude, deliveryRadiusMeters: radius }, "Location saved.")}>{busy === "location" ? "Saving…" : "Save location"}</button>
      </div>

      <div className="service-disclosure">
        <button type="button" className="service-disclosure-head" aria-expanded={zonesOpen} onClick={() => setZonesOpen((open) => !open)}><span>Delivery zones <small>{zones.length ? `${zones.length} extra ${zones.length === 1 ? "area" : "areas"}` : "Optional"}</small></span><ChevronDown size={16} className={zonesOpen ? "rotated" : ""} /></button>
        {zonesOpen && <div className="service-disclosure-body">
          <p className="service-hint">Add circles for areas outside the default radius, then give each one a name.</p>
          {zones.map((zone) => <div className="zone-row" key={zone.id}>
            <input aria-label="Zone name" value={zone.name} maxLength={60} onChange={(event) => patchZone(zone.id, { name: event.target.value })} />
            <label><input aria-label={`Radius for ${zone.name}`} type="number" min={0.25} max={25} step={0.25} value={Number((zone.radiusMeters / 1000).toFixed(2))} onChange={(event) => patchZone(zone.id, { radiusMeters: Math.round(Number(event.target.value) * 1000) })} /> km</label>
            <button type="button" className="icon-button small" aria-label={`Focus ${zone.name}`} onClick={() => setFocus({ latitude: zone.latitude, longitude: zone.longitude })}><MapPin size={15} /></button>
            <button type="button" className="icon-button small" aria-label={`Remove ${zone.name}`} onClick={() => setZones((current) => current.filter((entry) => entry.id !== zone.id))}><Trash2 size={15} /></button>
          </div>)}
          <button type="button" className="btn btn-quiet" disabled={!point} onClick={addZone}><Plus size={15} /> Add zone</button>
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void save("zones", { deliveryZones: zones }, "Delivery zones saved.")}>{busy === "zones" ? "Saving…" : "Save zones"}</button>
        </div>}
      </div>
    </section>

    <div className="service-stack">
      <section className="panel service-panel">
        <div className="section-heading"><div><h3>Weekly hours</h3><p>Repeat a different schedule on each day, in India Standard Time.</p></div><span className="settings-icon"><Clock3 size={19} /></span></div>
        <button type="button" className="btn btn-quiet" onClick={() => {
          const first = weekly.find((entry) => entry.enabled) ?? weekly[0];
          setWeekly((current) => current.map((entry) => ({ ...entry, opensAt: first.opensAt, closesAt: first.closesAt })));
        }}>Use one time for every day</button>
        <div className="week-list">
          {DAY_ORDER.map((day) => {
            const entry = weekly.find((row) => row.day === day) ?? { day, enabled: false, opensAt: "09:00", closesAt: "22:00" };
            return <div className="week-row" key={day}>
              <label className="week-day"><input type="checkbox" checked={entry.enabled} onChange={(event) => setWeekly((current) => current.map((row) => row.day === day ? { ...row, enabled: event.target.checked } : row))} />{DAY_LABELS[day]}</label>
              <input aria-label={`${DAY_LABELS[day]} opens`} type="time" value={entry.opensAt} onChange={(event) => setWeekly((current) => current.map((row) => row.day === day ? { ...row, opensAt: event.target.value } : row))} />
              <span>to</span>
              <input aria-label={`${DAY_LABELS[day]} closes`} type="time" value={entry.closesAt} onChange={(event) => setWeekly((current) => current.map((row) => row.day === day ? { ...row, closesAt: event.target.value } : row))} />
            </div>;
          })}
        </div>
        <p className="service-hint">Turn every day off to stay open whenever your store switch is on. This replaces the single daily schedule in Hours &amp; fulfilment.</p>
        <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void save("weekly-hours", { weeklyHours: weekly }, "Weekly hours saved.")}>{busy === "weekly-hours" ? "Saving…" : "Save weekly hours"}</button>
      </section>

      <section className="panel service-panel">
        <div className="section-heading"><div><h3>Day-part menus</h3><p>Show only selected items during breakfast, lunch or any other slot.</p></div><span className="settings-icon"><UtensilsCrossed size={19} /></span></div>
        {parts.map((part) => <div className="part-row" key={part.id}>
          <div className="part-info"><strong>{part.name}</strong><span>{part.opensAt} – {part.closesAt} · {describeDays(part.days)}</span><small>{part.itemIds.length ? `${part.itemIds.length} item${part.itemIds.length === 1 ? "" : "s"}` : "Full menu"} · {part.active ? "Active" : "Paused"}</small></div>
          <button type="button" className="btn btn-quiet" onClick={() => setDraft(part)}>Edit</button>
          <button type="button" className="icon-button small" aria-label={`Remove ${part.name}`} onClick={() => setParts((current) => current.filter((entry) => entry.id !== part.id))}><Trash2 size={15} /></button>
        </div>)}
        {draft ? <form className="part-form" onSubmit={savePart}>
          <div className="form-grid"><label>Name<input required maxLength={40} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Lunch" /></label><label>From<input required type="time" value={draft.opensAt} onChange={(event) => setDraft({ ...draft, opensAt: event.target.value })} /></label><label>Until<input required type="time" value={draft.closesAt} onChange={(event) => setDraft({ ...draft, closesAt: event.target.value })} /></label></div>
          <div className="day-chips">{DAY_ORDER.map((day) => <button type="button" key={day} aria-pressed={draft.days.includes(day)} className={draft.days.includes(day) ? "selected" : ""} onClick={() => toggleDay(day)}>{DAY_LABELS[day].slice(0, 3)}</button>)}<button type="button" className={draft.days.length === 0 ? "selected" : ""} onClick={() => setDraft({ ...draft, days: [] })}>All</button></div>
          <div className="part-item-list">{items.length ? items.map((item) => <label className="check-row" key={item.id}><input type="checkbox" checked={draft.itemIds.includes(item.id)} onChange={() => toggleItem(item.id)} /><span>{item.name}<small>{money(item.price)}</small></span></label>) : <span className="service-hint">Add menu items first to choose a time-slot menu.</span>}</div>
          <label className="check-row"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Active</label>
          <div className="service-actions"><button type="submit" className="btn btn-primary"><Check size={15} /> Add to list</button><button type="button" className="btn btn-quiet" onClick={() => setDraft(null)}>Cancel</button></div>
        </form> : <button type="button" className="btn btn-quiet" onClick={() => setDraft(emptyPart())}><Plus size={15} /> Add day part</button>}
        <p className="service-hint">Leave items unchecked to show the full menu. While a part runs, the first-party storefront shows only its chosen items; paired listings need the matching fields published by Marketplace.</p>
        <button type="button" className="btn btn-primary" disabled={!!busy || !!draft} onClick={() => void save("day-parts", { dayParts: parts }, "Day parts saved.")}>{busy === "day-parts" ? "Saving…" : "Save day parts"}</button>
      </section>
    </div>
    {message && <p className="settings-message service-message" role="status">{message}</p>}
  </div>;
}
