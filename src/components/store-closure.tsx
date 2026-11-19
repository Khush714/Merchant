"use client";
import { useEffect, useState, type FormEvent } from "react";
import { CalendarOff, Power, Store } from "lucide-react";
import { closureState, indiaDate, type ScheduledLeave } from "@/lib/closure";

type Props = {
  business: {
    isOpen: boolean;
    closureReason?: string | null;
    closureUntil?: string | null;
    scheduledLeaves?: ScheduledLeave[];
  };
  onSave: (payload: Record<string, unknown>) => Promise<void>;
};

const DURATIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 2, label: "2 hours" },
  { hours: 4, label: "4 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "24 hours" },
];

/** Operational controls that overlay the base open switch, for this outlet only. */
export function StoreClosure({ business, onSave }: Props) {
  const state = closureState(business);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(2);
  const [leaveDate, setLeaveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const savedLeaves = JSON.stringify(business.scheduledLeaves ?? []);
  const [leaves, setLeaves] = useState<ScheduledLeave[]>(() => JSON.parse(savedLeaves) as ScheduledLeave[]);
  // Parent refreshes replace the authoritative leave list after a save.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLeaves(JSON.parse(savedLeaves) as ScheduledLeave[]); }, [savedLeaves]);

  async function run(action: string, payload: Record<string, unknown>, success: string) {
    setBusy(action); setMessage("");
    try { await onSave(payload); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save this change."); }
    finally { setBusy(""); }
  }

  function closeTemporarily(event: FormEvent) {
    event.preventDefault();
    const until = new Date(Date.now() + hours * 3_600_000).toISOString();
    void run("close", { action: "closure", closed: true, reason: reason.trim(), until }, "Temporary closure is live. Orders already placed are unchanged.");
  }

  function addLeave(event: FormEvent) {
    event.preventDefault();
    if (!leaveDate) return;
    setLeaves((current) => [...current.filter((leave) => leave.date !== leaveDate), { date: leaveDate, reason: leaveReason.trim() }].sort((a, b) => a.date.localeCompare(b.date)));
    setLeaveDate(""); setLeaveReason("");
  }

  return <section className="panel settings-panel">
    <div className="section-heading"><div><h3>Closure & leave</h3><p>Pause new orders without losing your regular schedule.</p></div><span className="settings-icon"><CalendarOff size={19} /></span></div>
    <div className={`closing-status ${state.closed ? "closed" : "open"}`} role="status">
      <Store size={17} />
      <div>
        <strong>{state.closed ? "Closed for new orders" : "Open for new orders"}</strong>
        <span>{state.closed ? state.reason : "Your normal hours and availability apply."}</span>
        {state.until && <span>Reopens automatically at {new Date(state.until).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST</span>}
      </div>
    </div>
    <form className="form-stack" onSubmit={closeTemporarily}>
      <div className="form-grid"><label>Reason<input maxLength={120} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Private event" /></label><label>Reopen after<select value={hours} onChange={(event) => setHours(Number(event.target.value))}>{DURATIONS.map((duration) => <option key={duration.hours} value={duration.hours}>{duration.label}</option>)}</select></label></div>
      <button className="btn btn-outline" disabled={!!busy}><CalendarOff size={16} /> {busy === "close" ? "Closing…" : "Close temporarily"}</button>
    </form>
    {state.closed && <button className="btn btn-primary" disabled={!!busy} onClick={() => void run("reopen", { action: "closure", closed: false }, "You're open for new orders again.")}><Power size={16} /> {busy === "reopen" ? "Reopening…" : "Reopen now"}</button>}
    <form className="form-stack" onSubmit={addLeave}>
      <div className="form-grid"><label>Leave date<input type="date" required min={indiaDate()} value={leaveDate} onChange={(event) => setLeaveDate(event.target.value)} /></label><label>Reason (optional)<input maxLength={80} value={leaveReason} onChange={(event) => setLeaveReason(event.target.value)} placeholder="e.g. Festival" /></label></div>
      <button className="btn btn-outline" type="submit"><CalendarOff size={16} /> Add leave day</button>
    </form>
    {(leaves.length > 0 || JSON.stringify(leaves) !== savedLeaves) && <div className="leave-list">{leaves.map((leave) => <div className="leave-row" key={leave.date}><span><strong>{leave.date}</strong>{leave.reason ? ` · ${leave.reason}` : ""}</span><button type="button" className="icon-button small" aria-label={`Remove leave ${leave.date}`} onClick={() => setLeaves((current) => current.filter((entry) => entry.date !== leave.date))}>Remove</button></div>)}<button className="btn btn-primary" disabled={!!busy || JSON.stringify(leaves) === savedLeaves} onClick={() => void run("leaves", { action: "leaves", leaves }, "Leave schedule saved.")}>{busy === "leaves" ? "Saving…" : "Save leave days"}</button></div>}
    {message && <p className="settings-message" role="status">{message}</p>}
  </section>;
}
