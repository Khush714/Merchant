"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Info, Plus, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { api, AUTH_EXPIRED_EVENT } from "@/components/dialogs";
import { can, ROLE_LABELS, type AppRole } from "@/lib/roles";
import type { ComplianceDocumentKind, ComplianceOverview, CompliancePayoutView, TaxInvoiceDto, TaxRegime } from "@/lib/types";

type Tab = "overview" | "documents" | "agreement" | "payout" | "invoices";
type CompletedOrder = { id: string; orderNumber: number; createdAt: string; total: number };
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "documents", label: "Documents" },
  { id: "agreement", label: "Agreement" },
  { id: "payout", label: "Payout" },
  { id: "invoices", label: "Invoices" },
];
const DOCUMENT_KINDS: { value: ComplianceDocumentKind; label: string; expiry: boolean }[] = [
  { value: "kyc_identity", label: "KYC identity proof", expiry: false },
  { value: "kyc_address", label: "KYC address proof", expiry: false },
  { value: "fssai_license", label: "FSSAI licence", expiry: true },
  { value: "gst_registration", label: "GST registration", expiry: false },
  { value: "pan_card", label: "PAN card", expiry: false },
  { value: "bank_proof", label: "Payout account proof", expiry: false },
];
const TAX_REGIMES: TaxRegime[] = ["unregistered", "regular", "composition"];
const pretty = (value: string) => value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
/** Matches the advisory rules in compliance-data: these states have nothing left to do. */
const DONE_STATUSES = new Set(["submitted", "not_applicable"]);
const DONE_PAYOUT_STATUSES = new Set(["configured", "verified"]);
const statusTag = (label: string, done: boolean) => <span className={`approval-tag${done ? " done" : ""}`}>{done && <CheckCircle2 size={12} aria-hidden="true" />}{label}</span>;

/** All data is scoped by the server to the active session outlet; no business id is sent from the browser. */
export function Compliance({ business, role, demo, onToast, onChanged }: {
  business: { name: string };
  role: AppRole;
  demo: boolean;
  onToast: (message: string) => void;
  onChanged: () => void;
}) {
  const writable = !demo && can(role, "compliance.write");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<ComplianceOverview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [legalName, setLegalName] = useState(""), [entityType, setEntityType] = useState(""), [gstin, setGstin] = useState(""), [pan, setPan] = useState("");
  const [taxRegime, setTaxRegime] = useState<TaxRegime>("unregistered"), [taxInclusive, setTaxInclusive] = useState(true), [taxRate, setTaxRate] = useState("0");
  const [fssaiNumber, setFssaiNumber] = useState(""), [fssaiExpiresAt, setFssaiExpiresAt] = useState("");
  const [payout, setPayout] = useState<CompliancePayoutView | null>(null), [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutMethod, setPayoutMethod] = useState<"upi" | "bank">("upi"), [upiId, setUpiId] = useState(""), [accountHolder, setAccountHolder] = useState(""), [accountNumber, setAccountNumber] = useState(""), [ifsc, setIfsc] = useState("");
  const [invoices, setInvoices] = useState<TaxInvoiceDto[]>([]), [invoiceMeta, setInvoiceMeta] = useState({ hasMore: false, paired: false });
  const [invoiceSource, setInvoiceSource] = useState<"" | "marketplace" | "proforma">(""), [invoiceBusy, setInvoiceBusy] = useState(false);
  const [syncFrom, setSyncFrom] = useState(""), [syncTo, setSyncTo] = useState(""), [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>([]);

  const loadOverview = useCallback(async () => {
    try { setOverview(await api<ComplianceOverview>("/api/merchant/compliance")); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load compliance details."); }
  }, []);
  // The component is mounted only on this page and keyed by outlet in the parent.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (!demo) void loadOverview(); }, [demo, loadOverview]);
  useEffect(() => {
    if (!overview) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLegalName(overview.compliance.legalName); setEntityType(overview.compliance.entityType);
    setGstin(overview.compliance.gstin); setPan(overview.compliance.pan);
    setTaxRegime(overview.compliance.taxRegime); setTaxInclusive(overview.compliance.taxInclusive);
    setTaxRate(String(overview.compliance.defaultTaxRateBps / 100));
    setFssaiNumber(overview.compliance.fssaiNumber); setFssaiExpiresAt(overview.compliance.fssaiExpiresAt?.slice(0, 10) ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [overview]);

  const loadPayout = useCallback(async () => {
    setPayoutBusy(true);
    try { setPayout((await api<{ payout: CompliancePayoutView }>("/api/merchant/compliance/payout")).payout); }
    catch (cause) { setPayout({ available: false, authoritative: false, status: "unavailable", methodLabel: "", reference: "", syncedAt: null, message: cause instanceof Error ? cause.message : "Could not load payout status." }); }
    finally { setPayoutBusy(false); }
  }, []);
  const loadInvoices = useCallback(async () => {
    setInvoiceBusy(true);
    try {
      const params = new URLSearchParams();
      if (invoiceSource) params.set("source", invoiceSource);
      const data = await api<{ invoices: TaxInvoiceDto[]; hasMore: boolean; paired: boolean }>(`/api/merchant/compliance/invoices?${params}`);
      setInvoices(data.invoices); setInvoiceMeta({ hasMore: data.hasMore, paired: data.paired }); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load invoices."); }
    finally { setInvoiceBusy(false); }
  }, [invoiceSource]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (tab === "payout" && !demo) void loadPayout(); }, [tab, demo, loadPayout]);
  useEffect(() => {
    if (tab !== "invoices" || demo) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInvoices();
  }, [tab, demo, loadInvoices]);
  useEffect(() => {
    if (tab !== "invoices" || demo || !writable || overview?.compliance.paired) return;
    let active = true;
    api<{ orders: CompletedOrder[] }>("/api/merchant/orders?status=completed&limit=50")
      .then((data) => { if (active) setCompletedOrders(data.orders); })
      .catch(() => { if (active) setCompletedOrders([]); });
    return () => { active = false; };
  }, [tab, demo, writable, overview?.compliance.paired]);

  async function saveDetails(event: FormEvent) {
    event.preventDefault(); setBusy("details"); setMessage("");
    const rate = Number(taxRate);
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 2800) { setMessage("Tax rate must be between 0 and 28 percent."); setBusy(""); return; }
    try {
      setOverview(await api<ComplianceOverview>("/api/merchant/compliance", {
        method: "PATCH",
        body: JSON.stringify({
          legalName, entityType, gstin, pan, taxRegime, taxInclusive,
          defaultTaxRateBps: Math.round(rate * 100),
          fssaiNumber, fssaiExpiresAt: fssaiExpiresAt || null,
        }),
      }));
      setMessage("Compliance details saved. Missing items stay advisory and do not block orders.");
      onToast("Compliance details saved."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not save compliance details."); }
    finally { setBusy(""); }
  }

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget;
    const data = new FormData(form); setBusy("document"); setMessage("");
    try {
      // api() forces JSON, so uploads use fetch directly and let the browser set the multipart boundary.
      const response = await fetch("/api/merchant/compliance/documents", { method: "POST", body: data, cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 && payload && typeof payload === "object" && (payload as { code?: string }).code === "AUTH_REQUIRED" && typeof window !== "undefined") {
          window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        }
        throw new Error(typeof payload.error === "string" ? payload.error : "Could not upload the document.");
      }
      form.reset(); await loadOverview();
      setMessage("Document encrypted and uploaded. Only the masked metadata is stored locally.");
      onToast("Document uploaded."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not upload the document."); }
    finally { setBusy(""); }
  }

  async function removeDocument(id: string, name: string) {
    if (!window.confirm(`Remove ${name}? This deletes the encrypted copy from private storage.`)) return;
    setBusy(`document-${id}`); setMessage("");
    try {
      await api(`/api/merchant/compliance/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadOverview(); setMessage("Document removed."); onToast("Document removed."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not remove the document."); }
    finally { setBusy(""); }
  }

  async function acceptAgreement() {
    const agreement = overview?.compliance.agreement;
    if (!agreement) return;
    setBusy("agreement"); setMessage("");
    try {
      const result = await api<{ agreement: ComplianceOverview["compliance"]["agreement"] }>("/api/merchant/compliance/agreement", {
        method: "POST",
        body: JSON.stringify({ accepted: true, version: agreement.version, contentHash: agreement.contentHash }),
      });
      setOverview((current) => current ? { ...current, compliance: { ...current.compliance, agreement: result.agreement } } : current);
      setMessage(`Accepted agreement version ${result.agreement.version}.`);
      onToast("Agreement accepted."); onChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Could not accept the agreement. Refresh and review the current version.");
      await loadOverview();
    } finally { setBusy(""); }
  }

  async function savePayout(event: FormEvent) {
    event.preventDefault(); setPayoutBusy(true); setMessage("");
    try {
      const body = payoutMethod === "upi" ? { method: "upi", upiId } : { method: "bank", accountHolderName: accountHolder, accountNumber, ifsc };
      const result = await api<{ payout: CompliancePayoutView }>("/api/merchant/compliance/payout", { method: "POST", body: JSON.stringify(body) });
      setPayout(result.payout); setUpiId(""); setAccountNumber("");
      setMessage("Details forwarded to Marketplace. Only the masked label is stored here.");
      onToast("Payout details submitted to Marketplace."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not submit payout details."); }
    finally { setPayoutBusy(false); }
  }

  async function syncInvoices(event: FormEvent) {
    event.preventDefault(); setInvoiceBusy(true); setMessage("");
    try {
      const result = await api<{ sync: { available: boolean; received: number; applied: number; skipped: number; message?: string } }>("/api/merchant/compliance/invoices", {
        method: "POST", body: JSON.stringify({ action: "sync", from: syncFrom || undefined, to: syncTo || undefined }),
      });
      await loadInvoices();
      setMessage(result.sync.available ? `Mirrored ${result.sync.applied} invoice(s) from Marketplace.` : result.sync.message ?? "Marketplace does not expose invoices on this deployment.");
      onToast("Invoice sync finished."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not sync invoices."); }
    finally { setInvoiceBusy(false); }
  }

  async function createProForma(orderId: string) {
    setInvoiceBusy(true); setMessage("");
    try {
      const result = await api<{ invoice: TaxInvoiceDto }>("/api/merchant/compliance/invoices", { method: "POST", body: JSON.stringify({ action: "proforma", orderId }) });
      await loadInvoices(); setMessage(`Created pro forma ${result.invoice.invoiceNumber}. It is not a tax invoice.`);
      onToast("Pro forma document created."); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Could not create the pro forma document."); }
    finally { setInvoiceBusy(false); }
  }

  if (demo) return <div className="empty-state"><span><ShieldCheck size={25} /></span><strong>Demo workspace</strong><p>Compliance records are available for a real signed-in outlet.</p></div>;
  const summary = overview?.compliance;
  const documents = overview?.documents ?? [];

  return <>
    <div className="page-intro"><div><div className="eyebrow">RECORDS &amp; PAYOUTS <span>✳</span></div><h1>Compliance</h1><p>Keep registration records, documents and payout details current for {business.name}. Missing items are advisory only.</p></div><span className="role-chip"><ShieldCheck size={15} /> {ROLE_LABELS[role]}</span></div>
    <div className="earnings-tabs" role="tablist" aria-label="Compliance views">{TABS.map((item) => <button role="tab" key={item.id} aria-selected={tab === item.id} className={tab === item.id ? "selected" : ""} onClick={() => { setTab(item.id); setMessage(""); }}>{item.label}</button>)}</div>
    {!writable && <div className="info-box"><Info size={14} /> Your role has read-only access. An owner can upload documents, accept the agreement, submit payout details and manage invoices.</div>}
    {error && <div className="approval-banner"><Info size={18} /> <span>{error}</span><button onClick={() => void loadOverview()}>Retry</button></div>}
    {message && <p className="settings-message" role="status">{message}</p>}

    {tab === "overview" && <>
      {summary?.advisories.length ? <div className="approval-banner compliance-advisories"><AlertTriangle size={18} /><div><strong>{summary.advisories.length} advisory item{summary.advisories.length === 1 ? "" : "s"}</strong>{summary.advisories.map((item) => <span key={item.key}>{item.label} — {item.detail}</span>)}</div></div> : <div className="info-box"><CheckCircle2 size={14} /> No compliance advisories for this outlet.</div>}
      {summary && <div className="compliance-status-grid">
        <div className="compliance-status-card"><strong>KYC documents</strong>{statusTag(pretty(summary.kycStatus), DONE_STATUSES.has(summary.kycStatus))}<span>Identity and address proof</span></div>
        <div className="compliance-status-card"><strong>FSSAI licence</strong>{statusTag(pretty(summary.fssaiStatus), DONE_STATUSES.has(summary.fssaiStatus))}<span>{summary.fssaiNumber || "Number not added"}{summary.fssaiExpiresAt ? ` · expires ${summary.fssaiExpiresAt.slice(0, 10)}` : ""}</span></div>
        <div className="compliance-status-card"><strong>Tax registration</strong>{statusTag(pretty(summary.taxStatus), DONE_STATUSES.has(summary.taxStatus))}<span>{summary.gstin || (summary.taxRegime === "unregistered" ? "Unregistered" : "GSTIN not added")}</span></div>
        <div className="compliance-status-card"><strong>Agreement</strong>{statusTag(summary.agreement.accepted ? "Accepted" : "Not accepted", summary.agreement.accepted)}<span>Version {summary.agreement.version}</span></div>
        <div className="compliance-status-card"><strong>Payout</strong>{statusTag(pretty(summary.payoutStatus), DONE_PAYOUT_STATUSES.has(summary.payoutStatus))}<span>{summary.payoutMethodLabel || (summary.paired ? "Managed in Marketplace" : "Connect Marketplace to set up payouts")}</span></div>
      </div>}
      <section className="panel settings-panel"><div className="section-heading"><div><h3>Registration details</h3><p>Free-text legal details used on pro forma documents. Format checks apply to GSTIN, PAN and FSSAI.</p></div><span className="settings-icon"><FileText size={19} /></span></div>
        <form className="form-stack" onSubmit={(event) => void saveDetails(event)}>
          <div className="form-grid"><label>Legal name<input value={legalName} maxLength={200} onChange={(event) => setLegalName(event.target.value)} disabled={!writable} /></label><label>Entity type<input value={entityType} maxLength={80} onChange={(event) => setEntityType(event.target.value)} disabled={!writable} /></label><label>GSTIN<input value={gstin} maxLength={20} placeholder="27AAPFU0939F1ZV" onChange={(event) => setGstin(event.target.value.toUpperCase())} disabled={!writable} /></label><label>PAN<input value={pan} maxLength={20} placeholder="ATPPB1234K" onChange={(event) => setPan(event.target.value.toUpperCase())} disabled={!writable} /></label></div>
          <div className="form-grid"><label>Tax regime<select value={taxRegime} onChange={(event) => setTaxRegime(event.target.value as TaxRegime)} disabled={!writable}>{TAX_REGIMES.map((value) => <option value={value} key={value}>{pretty(value)}</option>)}</select></label><label>FSSAI number<input value={fssaiNumber} maxLength={20} inputMode="numeric" placeholder="14 digits" onChange={(event) => setFssaiNumber(event.target.value)} disabled={!writable} /></label><label>FSSAI expiry<input type="date" value={fssaiExpiresAt} onChange={(event) => setFssaiExpiresAt(event.target.value)} disabled={!writable} /></label><label>Default tax rate (%)<input type="number" min={0} max={28} step={0.25} value={taxRate} onChange={(event) => setTaxRate(event.target.value)} disabled={!writable} /></label></div>
          <label className="check-row"><input type="checkbox" checked={taxInclusive} onChange={(event) => setTaxInclusive(event.target.checked)} disabled={!writable} /> Prices include tax</label>
          {gstin && taxRegime === "unregistered" && <p className="form-error">Choose a registered tax regime when adding a GSTIN.</p>}
          {!gstin && taxRegime !== "unregistered" && <p className="form-error">Add a GSTIN for a registered tax regime.</p>}
          {writable && <button className="btn btn-primary" disabled={!!busy}>{busy === "details" ? "Saving…" : "Save compliance details"}</button>}
        </form>
      </section>
      <div className="info-box">Submission is not verification: details and files are checked for format, expiry and file type only. No registry is contacted and missing items never block orders or payouts.</div>
    </>}

    {tab === "documents" && <>
      <section className="panel settings-panel"><div className="section-heading"><div><h3>Document vault</h3><p>Files are encrypted before they reach private storage. Downloads are served by this app, never from a public URL.</p></div><span className="settings-icon"><ShieldCheck size={19} /></span></div>
        {documents.length ? <div className="staff-list">{documents.map((document) => <div className="staff-row" key={document.id}><div className="staff-identity"><FileText size={17} /><div><strong>{document.label}</strong><span className="block muted">{document.fileName} · {(document.byteSize / 1024).toFixed(0)} KB · uploaded {document.createdAt.slice(0, 10)}</span>{document.expiresAt && <span className="block muted">Expires {document.expiresAt.slice(0, 10)}</span>}</div></div><a className="btn btn-outline" href={`/api/merchant/compliance/documents/${encodeURIComponent(document.id)}`} download><Download size={15} /> Download</a>{writable && <button className="icon-button" aria-label={`Remove ${document.label}`} disabled={busy === `document-${document.id}`} onClick={() => void removeDocument(document.id, document.label)}><Trash2 size={15} /></button>}</div>)}</div> : <div className="empty-state"><span><FileText size={25} /></span><strong>No documents yet</strong><p>Upload identity, licence and registration proof for this outlet.</p></div>}
      </section>
      {writable && <form className="panel settings-panel" onSubmit={(event) => void uploadDocument(event)}><div className="section-heading"><div><h3>Upload a document</h3><p>PDF, PNG, JPEG or WebP, up to {Math.floor((overview?.limits.maxDocumentBytes ?? 0) / (1024 * 1024))} MB. Contents are checked against the file type.</p></div><span className="settings-icon"><Upload size={19} /></span></div>
        <div className="form-grid"><label>Document kind<select name="kind" required defaultValue="">{DOCUMENT_KINDS.map((kind) => <option key={kind.value} value={kind.value} disabled={!kind.value}>{kind.label}</option>)}</select></label><label>File<input name="file" type="file" required accept="application/pdf,image/png,image/jpeg,image/webp" /></label></div>
        <label className="check-row"><input type="checkbox" id="compliance-document-expiry" onChange={(event) => { const field = document.getElementById("compliance-document-expiry-date") as HTMLInputElement | null; if (field) field.disabled = !event.target.checked; }} /> This document has an expiry date</label>
        <label>Expiry date<input name="expiresAt" id="compliance-document-expiry-date" type="date" disabled /></label>
        <button className="btn btn-primary" disabled={!!busy}>{busy === "document" ? "Encrypting & uploading…" : "Upload document"}</button>
      </form>}
      <div className="info-box">Private storage must be configured on the server. If it is not, uploads and downloads return a configuration error and no local record is created.</div>
    </>}

    {tab === "agreement" && <section className="panel settings-panel"><div className="section-heading"><div><h3>{summary?.agreement.title ?? "Merchant agreement"}</h3><p>Version {summary?.agreement.version ?? "—"} · effective {summary?.agreement.effectiveAt.slice(0, 10) ?? "—"}</p></div><span className="settings-icon"><ShieldCheck size={19} /></span></div>
      <div className="info-box">Content hash: <span>{summary?.agreement.contentHash ?? "—"}</span></div>
      <div className="agreement-body">{summary?.agreement.body ?? "Loading agreement…"}</div>
      {summary?.agreement.accepted ? <div className="info-box"><CheckCircle2 size={14} /> Accepted {summary.agreement.acceptedAt ? new Date(summary.agreement.acceptedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "previously"} for this outlet and version.</div> : writable ? <button className="btn btn-primary" disabled={!!busy} onClick={() => void acceptAgreement()}>{busy === "agreement" ? "Recording…" : "I accept this agreement"}</button> : <div className="info-box">An owner must accept the current version. Acceptance is recorded per outlet and version.</div>}
      <div className="info-box">A new agreement version needs a fresh acceptance. Previous acceptances are kept as an append-only record.</div>
    </section>}

    {tab === "payout" && <>
      <section className="panel settings-panel"><div className="section-heading"><div><h3>Payout status</h3><p>Bank and UPI details are managed by Marketplace. This app stores only a masked label and a reference.</p></div><span className="settings-icon"><ShieldCheck size={19} /></span></div>
        {payoutBusy ? <p className="dialog-copy">Checking Marketplace…</p> : <><div className="info-box"><strong>{pretty(payout?.status ?? "not_configured")}</strong><br />{payout?.message ?? "Connect this outlet to Marketplace to manage payouts."}</div>{payout?.methodLabel && <div className="info-box">Method: {payout.methodLabel}{payout.reference ? ` · reference ${payout.reference}` : ""}{payout.syncedAt ? ` · synced ${payout.syncedAt.slice(0, 16).replace("T", " ")} UTC` : ""}</div>}{payout && !payout.available && <div className="info-box">Showing the last mirrored state. The Marketplace deployment does not expose this endpoint.</div>}</>}
        <button className="btn btn-outline" disabled={payoutBusy} onClick={() => void loadPayout()}><RefreshCw size={15} /> Refresh status</button>
      </section>
      {writable && <form className="panel settings-panel" onSubmit={(event) => void savePayout(event)}><div className="section-heading"><div><h3>Submit payout details</h3><p>Raw account details go directly to Marketplace and are never stored or logged here.</p></div><span className="settings-icon"><ShieldCheck size={19} /></span></div>
        <label>Method<select value={payoutMethod} onChange={(event) => setPayoutMethod(event.target.value as "upi" | "bank")}><option value="upi">UPI</option><option value="bank">Bank account</option></select></label>
        {payoutMethod === "upi" ? <label>UPI ID<input required value={upiId} maxLength={120} placeholder="merchant@bank" onChange={(event) => setUpiId(event.target.value)} /></label> : <div className="form-grid"><label>Account holder<input required value={accountHolder} maxLength={120} onChange={(event) => setAccountHolder(event.target.value)} /></label><label>Account number<input required inputMode="numeric" maxLength={20} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} /></label><label>IFSC<input required maxLength={20} placeholder="HDFC0001234" value={ifsc} onChange={(event) => setIfsc(event.target.value.toUpperCase())} /></label></div>}
        <button className="btn btn-primary" disabled={payoutBusy}>{payoutBusy ? "Submitting…" : "Send to Marketplace"}</button>
      </form>}
    </>}

    {tab === "invoices" && <>
      <div className="earnings-tabs" role="tablist" aria-label="Invoice sources">{([["", "All"], ["marketplace", "Marketplace"], ["proforma", "Pro forma"]] as const).map(([value, label]) => <button role="tab" key={value || "all"} aria-selected={invoiceSource === value} className={invoiceSource === value ? "selected" : ""} onClick={() => setInvoiceSource(value)}>{label}</button>)}</div>
      {invoiceMeta.paired && writable && <form className="panel settings-panel" onSubmit={(event) => void syncInvoices(event)}><div className="section-heading"><div><h3>Mirror Marketplace invoices</h3><p>Paired outlets mirror Marketplace-issued tax invoices. Dates are inclusive calendar days.</p></div><span className="settings-icon"><RefreshCw size={19} /></span></div><div className="form-grid"><label>From<input type="date" value={syncFrom} max={syncTo || undefined} onChange={(event) => setSyncFrom(event.target.value)} /></label><label>To<input type="date" value={syncTo} min={syncFrom || undefined} onChange={(event) => setSyncTo(event.target.value)} /></label></div><button className="btn btn-primary" disabled={invoiceBusy}>{invoiceBusy ? "Syncing…" : "Sync invoices"}</button></form>}
      {!invoiceMeta.paired && writable && <form className="panel settings-panel" onSubmit={(event) => { event.preventDefault(); const value = new FormData(event.currentTarget).get("orderId"); if (typeof value === "string" && value) void createProForma(value); }}><div className="section-heading"><div><h3>Create a pro forma document</h3><p>Only for completed local orders on unpaired outlets. This is not a GST tax invoice.</p></div><span className="settings-icon"><FileText size={19} /></span></div><label>Completed order<select name="orderId" required defaultValue="" disabled={!completedOrders.length}><option value="" disabled>Select a completed order</option>{completedOrders.map((order) => <option value={order.id} key={order.id}>#{order.orderNumber} · {order.createdAt.slice(0, 10)}</option>)}</select></label>{!completedOrders.length && <p className="dialog-copy">No completed local orders are available yet.</p>}<button className="btn btn-primary" disabled={invoiceBusy || !completedOrders.length}>{invoiceBusy ? "Creating…" : "Create pro forma"}</button></form>}
      <section className="panel item-report"><div className="section-heading"><div><h3>Invoice history</h3><p>Marketplace mirrors are labelled as such; pro forma documents are clearly marked.</p></div><span className="settings-icon"><FileText size={19} /></span></div>
        {invoices.length ? <div className="item-report-table"><div className="item-report-head compliance-invoice-row"><span>Invoice</span><span>Date</span><span>Total</span><span>Document</span></div>{invoices.map((invoice) => <div className="compliance-invoice-row" key={invoice.id}><span><strong>{invoice.invoiceNumber}</strong><span className="block muted">{invoice.source === "marketplace" ? "Marketplace mirror" : "Pro forma"} · {pretty(invoice.status)}</span></span><span>{invoice.issuedAt.slice(0, 10)}</span><span><strong>{(invoice.totalAmount / 100).toFixed(2)}</strong> {invoice.currency}</span><a className="btn btn-outline" href={`/api/merchant/compliance/invoices/${encodeURIComponent(invoice.id)}/pdf`} download><Download size={14} /> PDF</a></div>)}</div> : <div className="empty-state"><span><FileText size={25} /></span><strong>No invoices yet</strong><p>{invoiceMeta.paired ? "Sync Marketplace invoices to see them here." : "Create a pro forma document from a completed local order."}</p></div>}
      </section>
      {invoiceMeta.hasMore && <p className="dialog-copy">Showing the 50 most recent invoices. Narrow the source or use the Marketplace partner console for older records.</p>}
      <div className="info-box">Marketplace owns tax configuration, calculation and the original tax invoice. Locally generated PDFs are labelled mirrors or pro forma documents and are never presented as originals.</div>
    </>}
  </>;
}
