"use client";
/**
 * Advanced money workflows live here, never on Home. Each tab reads from an in-memory cache
 * that is loaded in parallel when Earnings opens, so switching tabs is an instant local render.
 * Mutations update that cache optimistically and revalidate in the background.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, CreditCard, Download, FileText, Info, Play, Plus, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { api } from "@/components/dialogs";
import { can, type AppRole } from "@/lib/roles";
import {
  money,
  type FeeScheduleDto,
  type FinanceSummary,
  type PayoutInbox,
  type ReconciliationReportDto,
  type RefundInbox,
  type RefundRecord,
  type SettlementLinePage,
  type SettlementLineRecord,
  type StatementDetail,
  type StatementRecord,
} from "@/lib/types";

export type EarningsTab =
  | "overview" | "revenue" | "items" | "payments" | "insights"
  | "breakdown" | "refunds" | "statements" | "reconciliation" | "payouts" | "fees";

type Props = {
  active: EarningsTab;
  role: AppRole;
  demo: boolean;
  businessId?: string;
  epoch: number;
  onChanged: () => void;
  notify: (message: string) => void;
};

const ZERO_FINANCE: FinanceSummary = {
  grossPaise: 0, commissionPaise: 0, gatewayFeePaise: 0, taxPaise: 0, refundPaise: 0,
  adjustmentPaise: 0, netPaise: 0, settlementCount: 0, statementCount: 0, allocatedPaise: 0, unallocatedPaise: 0,
};
const EMPTY_REFUNDS: RefundInbox = { available: true, notice: "", refunds: [], canWrite: false };
const EMPTY_PAYOUTS: PayoutInbox = {
  available: true, notice: "", payouts: [], summary: { totalPaise: 0, completedPaise: 0, unallocatedPaise: 0 },
};
const EMPTY_RECON: ReconciliationReportDto = {
  available: true, notice: "", latestRun: null, exceptions: [], counts: {},
  summary: { matchedSettlements: 0, allocatedSettlements: 0, openExceptions: 0 },
};

function badge(status: string) {
  const value = status.toLowerCase();
  const tone = ["settled", "paid", "completed", "approved", "resolved"].includes(value) ? ""
    : ["failed", "rejected", "critical", "error"].includes(value) ? "bad" : "warn";
  return <span className={`finance-badge ${tone}`}>{status.replaceAll("_", " ")}</span>;
}
function rupeesToPaise(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return Number.NaN;
  return Math.round(amount * 100);
}
function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() { return `${today().slice(0, 8)}01`; }
function errMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong."; }

export function FinanceTabs({ active, role, demo, businessId, epoch, onChanged, notify }: Props) {
  const [finance, setFinance] = useState<FinanceSummary>(ZERO_FINANCE);
  const [lines, setLines] = useState<SettlementLineRecord[]>([]);
  const [lineCursor, setLineCursor] = useState<string | null>(null);
  const [linesHasMore, setLinesHasMore] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const [refunds, setRefunds] = useState<RefundInbox>(EMPTY_REFUNDS);
  const [statements, setStatements] = useState<StatementRecord[]>([]);
  const [payouts, setPayouts] = useState<PayoutInbox>(EMPTY_PAYOUTS);
  const [recon, setRecon] = useState<ReconciliationReportDto>(EMPTY_RECON);
  const [fee, setFee] = useState<FeeScheduleDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [openStatement, setOpenStatement] = useState<StatementDetail | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    if (demo || !businessId) return;
    setBusy(true);
    setLinesLoading(true);
    const get = <T,>(path: string) => api<T>(path, { signal }).catch(() => null);
    try {
      const [f, l, r, s, p, c, feeData] = await Promise.all([
        get<FinanceSummary>("/api/merchant/finance"),
        get<SettlementLinePage>("/api/merchant/settlement-lines?limit=200"),
        get<RefundInbox>("/api/merchant/refunds"),
        get<{ statements: StatementRecord[] }>("/api/merchant/statements"),
        get<PayoutInbox>("/api/merchant/payouts"),
        get<ReconciliationReportDto>("/api/merchant/reconciliation"),
        get<{ schedule: FeeScheduleDto }>("/api/merchant/fees"),
      ]);
      if (signal.aborted) return;
      if (f) setFinance(f);
      if (l) {
        setLines(l.lines);
        setLineCursor(l.nextCursor);
        setLinesHasMore(l.hasMore);
      }
      if (r) setRefunds(r);
      if (s) setStatements(s.statements);
      if (p) setPayouts(p);
      if (c) setRecon(c);
      if (feeData) setFee(feeData.schedule);
    } finally {
      if (!signal.aborted) { setBusy(false); setLinesLoading(false); }
    }
  }, [demo, businessId]);

  // Load every finance view once when Earnings opens. Tab clicks then render cached state.
  useEffect(() => {
    const controller = new AbortController();
    // Like the other data preloads in this app, the request only settles after the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load, epoch]);

  const changed = useCallback(() => {
    onChanged();
    const controller = new AbortController();
    void load(controller.signal);
  }, [load, onChanged]);

  // Payout allocation choices load one keyset page at a time instead of silently truncating.
  const loadMoreLines = useCallback(async () => {
    if (!lineCursor || linesLoading) return;
    setLinesLoading(true);
    try {
      const path = `/api/merchant/settlement-lines?limit=200&cursor=${encodeURIComponent(lineCursor)}`;
      const page = await api<SettlementLinePage>(path).catch(() => null);
      if (!page) return;
      setLines((previous) => [...previous, ...page.lines]);
      setLineCursor(page.nextCursor);
      setLinesHasMore(page.hasMore);
    } finally { setLinesLoading(false); }
  }, [lineCursor, linesLoading]);

  async function run(path: string, body: unknown, success: string, key: string) {
    if (actionBusy) return;
    setActionBusy(key);
    try {
      const result = await api<{ notice?: string; message?: string }>(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
      });
      notify(result.notice || result.message || success);
      changed();
    } catch (error) { notify(errMessage(error)); }
    finally { setActionBusy(""); }
  }

  async function openDetail(id: string) {
    if (openStatement?.id === id) { setOpenStatement(null); return; }
    if (actionBusy) return;
    setActionBusy(`statement-detail-${id}`);
    try {
      const result = await api<{ statement: StatementDetail }>(`/api/merchant/statements/${id}`);
      setOpenStatement(result.statement);
    } catch (error) { notify(errMessage(error)); }
    finally { setActionBusy(""); }
  }

  const canWriteRefund = !demo && can(role, "payments.refund");
  const canFinance = !demo && can(role, "finance.write");

  // ---------------------------------------------------------------- Gross → net waterfall
  if (active === "breakdown") {
    if (demo) return <div className="info-box">A gross-to-net settlement breakdown appears here once you leave demo mode and connect an outlet.</div>;
    return <section className="panel item-report">
      <div className="section-heading"><div><h3>Gross to net</h3><p>How collections become a settlement. Money is in paise from the authoritative feed.</p></div><span className="settings-icon"><CircleDollarSign size={20} /></span></div>
      {busy && <span className="revenue-updating">Updating…</span>}
      <div className="finance-row"><span>Gross collections <small>{finance.settlementCount} settlement lines</small></span><strong>{money(finance.grossPaise)}</strong></div>
      <div className="finance-row negative"><span>Commission <small>Marketplace platform fee</small></span><strong>−{money(finance.commissionPaise)}</strong></div>
      <div className="finance-row negative"><span>Gateway fees <small>{finance.gatewayFeePaise ? "Configured locally" : "No local gateway fee configured"}</small></span><strong>−{money(finance.gatewayFeePaise)}</strong></div>
      <div className="finance-row negative"><span>Tax on fees <small>Never charged on the food bill</small></span><strong>−{money(finance.taxPaise)}</strong></div>
      <div className="finance-row negative"><span>Refunds <small>Confirmed reversals</small></span><strong>−{money(finance.refundPaise)}</strong></div>
      <div className="finance-row"><span>Adjustments <small>Upstream corrections</small></span><strong>{money(finance.adjustmentPaise)}</strong></div>
      <div className="finance-row total"><span>Net settlement</span><strong>{money(finance.netPaise)}</strong></div>
      <div className="info-box">Marketplace is the source of truth for commission, refunds and adjustments. A configured gateway or tax split that changes the mirrored net raises a reconciliation exception instead of rewriting it.</div>
    </section>;
  }

  // ---------------------------------------------------------------- Refunds
  if (active === "refunds") {
    const counts = refunds.refunds.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    return <>
      {demo ? <div className="info-box">Refund requests and approvals appear here once you leave demo mode.</div> : !refunds.available ? <div className="info-box">{refunds.notice}</div> : <>
        <div className="earnings-grid revenue-stats">
          <div className="metric-card"><span className="metric-title">Requested</span><strong className="metric-value">{counts.requested ?? 0}</strong></div>
          <div className="metric-card"><span className="metric-title">Approved</span><strong className="metric-value">{counts.approved ?? 0}</strong></div>
          <div className="metric-card"><span className="metric-title">Settled</span><strong className="metric-value">{counts.settled ?? 0}</strong></div>
          <div className="metric-card"><span className="metric-title">Rejected</span><strong className="metric-value">{counts.rejected ?? 0}</strong></div>
        </div>
        {canWriteRefund && <RefundRequestForm busy={actionBusy === "refund-new"} onSubmit={(orderNumber, amountPaise, reason) => run("/api/merchant/refunds", { orderNumber, amountPaise, reason }, "Refund request created. No money has moved yet.", "refund-new")} />}
        <section className="panel item-report">
          <div className="section-heading"><div><h3>Refund log</h3><p>Requests, approvals and settled reversals for unpaired outlets.</p></div><span className="settings-icon"><RotateCcw size={20} /></span></div>
          {refunds.refunds.length ? <div className="finance-table" style={{ gridTemplateColumns: "minmax(0,1fr) 100px 90px 90px 150px" }}>
            <div className="finance-table-head" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px 90px 90px 150px" }}><span>Order</span><span>Amount</span><span>Status</span><span>Reason</span><span /></div>
            {refunds.refunds.map((row) => <div className="finance-table-row" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px 90px 90px 150px" }} key={row.id}>
              <span><strong>#{row.orderNumber}</strong><small>{row.customerName}</small></span>
              <span><strong>{money(row.amountPaise)}</strong></span>
              <span>{badge(row.status)}</span>
              <span title={row.reason}>{row.reason || "—"}</span>
              <span><RefundActions row={row} canWrite={canWriteRefund} busy={actionBusy} run={run} /></span>
            </div>)}
          </div> : <div className="empty-state"><span><RotateCcw size={25} /></span><strong>No refunds yet</strong><p>Approved refunds and provider reversals will appear here.</p></div>}
        </section>
        <div className="info-box">A refund request never moves money on its own. Approval and settlement are separate owner-only steps; paired outlets issue refunds in Marketplace.</div>
      </>}
      {busy && <span className="revenue-updating">Updating…</span>}
    </>;
  }

  // ---------------------------------------------------------------- Statements
  if (active === "statements") {
    return <>
      {demo ? <div className="info-box">Immutable settlement statements appear here once you leave demo mode.</div> : <>
        {canFinance && <StatementForm busy={actionBusy === "statement-new"} onSubmit={(from, to) => run("/api/merchant/statements", { from, to }, "Statement generated.", "statement-new")} />}
        <section className="panel item-report">
          <div className="section-heading"><div><h3>Settlement statements</h3><p>Merchant-generated mirrors for closed periods, with an immutable checksum.</p></div><span className="settings-icon"><FileText size={20} /></span></div>
          {statements.length ? statements.map((row) => <div key={row.id}>
            <div className="finance-table-row" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 110px 100px 90px 190px" }}>
              <span><strong>{row.number}</strong><small>{row.periodFrom} → {row.periodTo} · {row.lineCount} lines</small></span>
              <span>Gross <strong>{money(row.grossPaise)}</strong></span>
              <span>Net <strong>{money(row.netPaise)}</strong></span>
              <span>{badge(row.status)}</span>
              <span className="finance-actions">
                <button className="btn btn-outline" onClick={() => void openDetail(row.id)}>{openStatement?.id === row.id ? "Hide" : "View"}</button>
                <a className="btn btn-outline" href={`/api/merchant/statements/${row.id}/pdf`} download><Download size={14} /> PDF</a>
                <a className="btn btn-outline" href={`/api/merchant/statements/${row.id}/csv`} download><Download size={14} /> CSV</a>
              </span>
            </div>
            {openStatement?.id === row.id && <StatementDetailView detail={openStatement} />}
          </div>) : <div className="empty-state"><span><FileText size={25} /></span><strong>No statements yet</strong><p>Generate one for a closed period to freeze its totals and line items.</p></div>}
        </section>
        <div className="info-box">Statements are merchant-generated mirrors, not bank statements or tax invoices. They keep their own totals even if a fee schedule or settlement changes later.</div>
      </>}
      {busy && <span className="revenue-updating">Updating…</span>}
    </>;
  }

  // ---------------------------------------------------------------- Reconciliation
  if (active === "reconciliation") {
    return <>
      {demo ? <div className="info-box">Order, collection and payout reconciliation appears here once you leave demo mode.</div> : <>
        <div className="earnings-grid revenue-stats">
          <div className="metric-card"><span className="metric-title">Open exceptions</span><strong className="metric-value">{recon.summary.openExceptions}</strong></div>
          <div className="metric-card"><span className="metric-title">Matched settlements</span><strong className="metric-value">{recon.summary.matchedSettlements}</strong></div>
          <div className="metric-card"><span className="metric-title">Allocated to payouts</span><strong className="metric-value">{recon.summary.allocatedSettlements}</strong></div>
          <div className="metric-card"><span className="metric-title">Exceptions</span><strong className="metric-value">{recon.exceptions.length}</strong></div>
        </div>
        <div className="finance-actions">
          {canFinance && <button className="btn btn-primary" disabled={!!actionBusy} onClick={() => void run("/api/merchant/reconciliation", {}, "Reconciliation completed.", "recon-run")}><Play size={15} /> {actionBusy === "recon-run" ? "Running…" : "Run reconciliation"}</button>}
          {busy && <span className="revenue-updating">Updating…</span>}
        </div>
        <section className="panel item-report" style={{ marginTop: 14 }}>
          <div className="section-heading"><div><h3>Exceptions</h3><p>{recon.latestRun ? `Last run ${new Date(recon.latestRun.startedAt).toLocaleString()}` : recon.notice || "No runs yet."}</p></div><span className="settings-icon"><AlertTriangle size={20} /></span></div>
          {recon.exceptions.length ? recon.exceptions.map((row) => <div className="finance-table-row" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 80px 90px 90px 130px" }} key={row.id}>
            <span><strong>{row.kind.replaceAll("_", " ")}</strong><small>{row.detail}</small></span>
            <span>{badge(row.severity)}</span>
            <span>{row.expectedPaise ? money(row.expectedPaise) : "—"}</span>
            <span>{row.actualPaise ? money(row.actualPaise) : "—"}</span>
            <span>{row.status === "open" && canFinance ? <button className="btn btn-outline" disabled={!!actionBusy} onClick={() => {
              const note = window.prompt("Resolution note (what did you verify?)");
              if (note?.trim()) void run(`/api/merchant/reconciliation/${row.id}/resolve`, { note }, "Exception resolved.", `resolve-${row.id}`);
            }}>Resolve</button> : badge(row.status)}</span>
          </div>) : <div className="empty-state"><span><CheckCircle2 size={25} /></span><strong>No exceptions</strong><p>The latest run found no mismatches, or no run has been recorded.</p></div>}
        </section>
        <div className="info-box">Reconciliation reports anomalies; it never changes source-of-truth money. Marketplace currently exposes no bank payout feed, so unallocated settlements are expected and reported as informational.</div>
      </>}
    </>;
  }

  // ---------------------------------------------------------------- Payouts
  if (active === "payouts") {
    return <>
      {demo ? <div className="info-box">The payout ledger appears here once you leave demo mode.</div> : <>
        <div className="earnings-grid revenue-stats">
          <div className="metric-card"><span className="metric-title">Recorded payouts</span><strong className="metric-value">{money(payouts.summary.totalPaise)}</strong></div>
          <div className="metric-card"><span className="metric-title">Completed</span><strong className="metric-value">{money(payouts.summary.completedPaise)}</strong></div>
          <div className="metric-card"><span className="metric-title">Unallocated net</span><strong className="metric-value">{money(payouts.summary.unallocatedPaise)}</strong></div>
        </div>
        <div className="finance-actions">
          {canFinance && <button className="btn btn-outline" disabled={!!actionBusy} onClick={() => void run("/api/merchant/payouts/sync", {}, "Payout sync finished.", "payout-sync")}><RefreshCw size={15} /> {actionBusy === "payout-sync" ? "Syncing…" : "Sync from Marketplace"}</button>}
        </div>
        {canFinance && <PayoutForm lines={lines} hasMore={linesHasMore} loading={linesLoading} onMore={() => void loadMoreLines()} busy={actionBusy === "payout-new"} onSubmit={(body) => run("/api/merchant/payouts", body, "Payout recorded.", "payout-new")} />}
        <section className="panel item-report" style={{ marginTop: 14 }}>
          <div className="section-heading"><div><h3>Payout ledger</h3><p>Mirrored or manually recorded payout references, distinct from provider capture. No transfer is initiated here.</p></div><span className="settings-icon"><CreditCard size={20} /></span></div>
          <div className="info-box">{payouts.notice}</div>
          {payouts.payouts.length ? <div className="finance-table">
            <div className="finance-table-head" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) 90px 90px 80px 110px" }}><span>Reference</span><span>Amount</span><span>Allocated</span><span>Status</span><span>Source</span></div>
            {payouts.payouts.map((row) => <div className="finance-table-row" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) 90px 90px 80px 110px" }} key={row.id}>
              <span><strong>{row.reference}</strong><small>{row.methodLabel || "No method label"}{row.completedAt ? ` · ${new Date(row.completedAt).toLocaleDateString()}` : ""}</small></span>
              <span><strong>{money(row.amountPaise)}</strong></span>
              <span>{money(row.allocatedPaise)}</span>
              <span>{badge(row.status)}</span>
              <span>{row.source === "marketplace" ? "Marketplace" : "Manual"}</span>
            </div>)}
          </div> : <div className="empty-state"><span><CreditCard size={25} /></span><strong>No payouts recorded</strong><p>Record a manual bank payout or sync one from Marketplace.</p></div>}
        </section>
      </>}
      {busy && <span className="revenue-updating">Updating…</span>}
    </>;
  }

  // ---------------------------------------------------------------- Fees
  if (active === "fees") {
    return <>
      {demo ? <div className="info-box">Fee schedules appear here once you leave demo mode.</div> : <>
        <section className="panel item-report">
          <div className="section-heading"><div><h3>Fee schedule</h3><p>Versioned per outlet. Zero gateway and tax fees preserve Marketplace’s authoritative net.</p></div><span className="settings-icon"><ShieldCheck size={20} /></span></div>
          {fee && <>
            <div className="finance-row"><span>Scope <small>{fee.inherited ? "Inherited from an older version" : "This outlet"}</small></span><strong>{fee.scope}</strong></div>
            <div className="finance-row"><span>Commission</span><strong>{fee.commissionBps} bps {fee.platformFixedPaise ? `+ ${money(fee.platformFixedPaise)}` : ""}</strong></div>
            <div className="finance-row"><span>Gateway</span><strong>{fee.gatewayBps} bps {fee.gatewayFixedPaise ? `+ ${money(fee.gatewayFixedPaise)}` : ""}</strong></div>
            <div className="finance-row"><span>Tax on fees</span><strong>{fee.gstBps} bps</strong></div>
            <div className="finance-row"><span>Effective from</span><strong>{new Date(fee.effectiveFrom).toLocaleString()}</strong></div>
          </>}
        </section>
        {canFinance && <FeeForm fee={fee} busy={actionBusy === "fee-save"} onSubmit={(body) => run("/api/merchant/fees", body, "Fee schedule saved.", "fee-save")} />}
        <div className="info-box">Fees are informational splits. A schedule that changes the mirrored net is flagged by reconciliation rather than silently rewriting the settlement. Historical statements keep their original totals.</div>
      </>}
      {busy && <span className="revenue-updating">Updating…</span>}
    </>;
  }

  return null;
}

// ---------------------------------------------------------------- form helpers

function RefundRequestForm({ busy, onSubmit }: { busy: boolean; onSubmit: (orderNumber: number, amountPaise: number, reason: string) => void }) {
  const [orderNumber, setOrderNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const amountPaise = rupeesToPaise(amount);
    const number = Number(orderNumber);
    if (!Number.isSafeInteger(number) || !Number.isFinite(amountPaise) || amountPaise <= 0 || !reason.trim()) return;
    onSubmit(number, amountPaise, reason.trim());
    setOrderNumber(""); setAmount(""); setReason("");
  }
  return <form className="finance-form" onSubmit={submit}>
    <label>Order number<input inputMode="numeric" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value.replace(/\D/g, ""))} placeholder="2847" required /></label>
    <label>Amount (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="250.00" required /></label>
    <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={250} placeholder="Customer requested cancellation" required /></label>
    <button className="btn btn-outline" type="submit" disabled={busy}><Plus size={15} /> {busy ? "Creating…" : "Request refund"}</button>
  </form>;
}

function RefundActions({ row, canWrite, busy, run }: {
  row: RefundRecord; canWrite: boolean; busy: string; run: (path: string, body: unknown, success: string, key: string) => Promise<void>;
}) {
  if (!canWrite) return <>{badge(row.status)}</>;
  if (row.status === "requested") return <span className="finance-actions">
    <button className="btn btn-outline" disabled={!!busy} onClick={() => void run(`/api/merchant/refunds/${row.id}/review`, { action: "approve" }, "Refund approved. No money has moved yet.", `refund-${row.id}`)}>Approve</button>
    <button className="btn btn-outline" disabled={!!busy} onClick={() => void run(`/api/merchant/refunds/${row.id}/review`, { action: "reject" }, "Refund rejected.", `refund-${row.id}`)}>Reject</button>
  </span>;
  if (row.status === "approved") return <button className="btn btn-primary" disabled={!!busy} onClick={() => {
    if (!window.confirm(`Settle ${money(row.amountPaise)} refund for order #${row.orderNumber}? This contacts the payment provider where configured.`)) return;
    void run(`/api/merchant/refunds/${row.id}/settle`, {}, "Refund settled.", `refund-${row.id}`);
  }}>{busy === `refund-${row.id}` ? "Settling…" : "Settle"}</button>;
  return <>{badge(row.status)}</>;
}

function StatementForm({ busy, onSubmit }: { busy: boolean; onSubmit: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  return <form className="finance-form" onSubmit={(event) => {
    event.preventDefault();
    if (from && to && from <= to) onSubmit(from, to);
  }}>
    <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></label>
    <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></label>
    <button className="btn btn-primary" type="submit" disabled={busy}><FileText size={15} /> {busy ? "Generating…" : "Generate statement"}</button>
  </form>;
}

function StatementDetailView({ detail }: { detail: StatementDetail }) {
  return <div className="variant-panel">
    <div className="finance-row total"><span>Net settled <small>{detail.lineCount} lines · checksum {detail.checksum}</small></span><strong>{money(detail.netPaise)}</strong></div>
    {detail.lines.length ? <div className="finance-table" style={{ marginTop: 8 }}>
      <div className="finance-table-head" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px 100px 100px" }}><span>Order</span><span>Gross</span><span>Fees</span><span>Net</span></div>
      {detail.lines.map((line) => <div className="finance-table-row" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px 100px 100px" }} key={line.id}>
        <span>#{line.orderNumber || line.settlementId.slice(0, 8)}</span>
        <span>{money(line.grossPaise)}</span>
        <span>{money(line.commissionPaise + line.gatewayFeePaise + line.taxPaise + line.refundPaise)}</span>
        <span><strong>{money(line.netPaise)}</strong></span>
      </div>)}
    </div> : <div className="info-box">No line items are linked to this statement.</div>}
  </div>;
}

function PayoutForm({ lines, hasMore, loading, onMore, busy, onSubmit }: {
  lines: SettlementLineRecord[];
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("paid");
  const [settlementId, setSettlementId] = useState("");
  const [search, setSearch] = useState("");
  // Search and a bounded option list keep large ledgers usable without loading
  // the entire history into the DOM. Loaded pages still cover every allocation choice.
  const options = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matched = term
      ? lines.filter((line) => line.orderNumber.toLowerCase().includes(term)
        || line.settlementId.toLowerCase().includes(term)
        || line.id.toLowerCase().includes(term))
      : lines;
    return matched.slice(0, 100);
  }, [lines, search]);
  const selected = useMemo(() => lines.find((line) => line.settlementId === settlementId), [lines, settlementId]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const amountPaise = rupeesToPaise(amount);
    if (!reference.trim() || !Number.isFinite(amountPaise) || amountPaise <= 0) return;
    const allocations = settlementId && selected ? [{ settlementId, amountPaise: Math.min(amountPaise, selected.netPaise) }] : [];
    onSubmit({ reference: reference.trim(), methodLabel: method.trim(), status, amountPaise, allocations });
    setReference(""); setMethod(""); setAmount(""); setSettlementId("");
  }
  return <form className="finance-form" onSubmit={submit}>
    <label>Reference<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={128} placeholder="UTR / bank ref" required /></label>
    <label>Method<input value={method} onChange={(e) => setMethod(e.target.value)} maxLength={120} placeholder="Bank ****1234" /></label>
    <label>Amount (₹)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="940.00" required /></label>
    <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}>
      <option value="scheduled">Scheduled</option><option value="processing">Processing</option>
      <option value="paid">Paid</option><option value="failed">Failed</option>
    </select></label>
    <label>Apply to settlement
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search order or settlement" aria-label="Search settlement lines" />
      <select value={settlementId} onChange={(e) => setSettlementId(e.target.value)}>
        <option value="">None</option>
        {options.map((line) => <option key={line.settlementId} value={line.settlementId}>#{line.orderNumber || line.id.slice(0, 8)} · {money(line.netPaise)}</option>)}
      </select>
      {hasMore && <button type="button" className="btn btn-outline" onClick={onMore} disabled={loading}>{loading ? "Loading…" : "Load more lines"}</button>}
      <small>{lines.length ? `Showing ${options.length} of ${lines.length} loaded lines` : "No settlement lines loaded"}</small>
    </label>
    <button className="btn btn-primary" type="submit" disabled={busy}><Plus size={15} /> {busy ? "Saving…" : "Record payout"}</button>
  </form>;
}

function FeeForm({ fee, busy, onSubmit }: { fee: FeeScheduleDto | null; busy: boolean; onSubmit: (body: Record<string, unknown>) => void }) {
  const [commissionBps, setCommissionBps] = useState(String(fee?.commissionBps ?? 0));
  const [platformFixed, setPlatformFixed] = useState(fee ? String(fee.platformFixedPaise / 100) : "0");
  const [gatewayBps, setGatewayBps] = useState(String(fee?.gatewayBps ?? 0));
  const [gatewayFixed, setGatewayFixed] = useState(fee ? String(fee.gatewayFixedPaise / 100) : "0");
  const [gstBps, setGstBps] = useState(String(fee?.gstBps ?? 0));
  function submit(event: FormEvent) {
    event.preventDefault();
    const platformFixedPaise = rupeesToPaise(platformFixed);
    const gatewayFixedPaise = rupeesToPaise(gatewayFixed);
    const values = [commissionBps, gatewayBps, gstBps].map(Number);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000)) return;
    if (!Number.isFinite(platformFixedPaise) || !Number.isFinite(gatewayFixedPaise)) return;
    onSubmit({ commissionBps: values[0], platformFixedPaise, gatewayBps: values[1], gatewayFixedPaise, gstBps: values[2] });
  }
  return <form className="finance-form" onSubmit={submit}>
    <label>Commission (bps)<input inputMode="numeric" value={commissionBps} onChange={(e) => setCommissionBps(e.target.value.replace(/\D/g, ""))} /></label>
    <label>Platform fixed (₹)<input inputMode="decimal" value={platformFixed} onChange={(e) => setPlatformFixed(e.target.value)} /></label>
    <label>Gateway (bps)<input inputMode="numeric" value={gatewayBps} onChange={(e) => setGatewayBps(e.target.value.replace(/\D/g, ""))} /></label>
    <label>Gateway fixed (₹)<input inputMode="decimal" value={gatewayFixed} onChange={(e) => setGatewayFixed(e.target.value)} /></label>
    <label>Tax on fees (bps)<input inputMode="numeric" value={gstBps} onChange={(e) => setGstBps(e.target.value.replace(/\D/g, ""))} /></label>
    <button className="btn btn-primary" type="submit" disabled={busy}><Info size={15} /> {busy ? "Saving…" : "Save fee schedule"}</button>
  </form>;
}
