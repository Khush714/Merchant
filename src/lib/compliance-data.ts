import "server-only";

import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import {
  businessCompliance, businesses, complianceAgreementAcceptances, complianceAgreements,
  complianceDocuments, orders, taxInvoices,
} from "@/db/schema";
import {
  assertComplianceConsistency, COMPLIANCE_AGREEMENT_BODY, COMPLIANCE_AGREEMENT_EFFECTIVE_AT,
  COMPLIANCE_AGREEMENT_TITLE, COMPLIANCE_AGREEMENT_VERSION, DOCUMENT_KIND_LABELS,
  agreementContentHash, expiryDateToDate, isExpired, maskPayout, normalizeComplianceDetails,
  normalizePayoutInput, parseRemoteInvoiceFeed, parseRemotePayout,
} from "@/lib/compliance-validation";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError } from "@/lib/server";
import type {
  ComplianceAgreementView, ComplianceDocumentDto, ComplianceDocumentKind, ComplianceInput,
  ComplianceOverview, CompliancePayoutView, ComplianceSummary, RemotePayout, TaxInvoiceDto,
} from "@/lib/types";

const PAYOUT_PATH = "/api/integration/merchant/compliance/payout";
const INVOICES_PATH = "/api/integration/merchant/compliance/invoices";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ComplianceRow = typeof businessCompliance.$inferSelect;
type DocumentRow = typeof complianceDocuments.$inferSelect;
type InvoiceRow = typeof taxInvoices.$inferSelect;

async function complianceRow(businessId: string): Promise<ComplianceRow | undefined> {
  const [row] = await db.select().from(businessCompliance).where(eq(businessCompliance.businessId, businessId)).limit(1);
  return row;
}

async function activeDocuments(businessId: string): Promise<DocumentRow[]> {
  return db.select().from(complianceDocuments).where(and(eq(complianceDocuments.businessId, businessId), eq(complianceDocuments.status, "active")))
    .orderBy(desc(complianceDocuments.createdAt)).limit(100);
}

function hasKind(documents: DocumentRow[], ...kinds: ComplianceDocumentKind[]) {
  return documents.some((document) => kinds.includes(document.kind as ComplianceDocumentKind));
}

export function documentDto(row: DocumentRow): ComplianceDocumentDto {
  return {
    id: row.id,
    kind: row.kind as ComplianceDocumentKind,
    label: DOCUMENT_KIND_LABELS[row.kind as ComplianceDocumentKind] ?? row.kind,
    fileName: row.fileName,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    uploadedBy: row.uploadedBy,
  };
}

export function invoiceDto(row: InvoiceRow): TaxInvoiceDto {
  return {
    id: row.id,
    businessId: row.businessId,
    invoiceNumber: row.invoiceNumber,
    source: row.source as TaxInvoiceDto["source"],
    externalId: row.externalId,
    orderId: row.orderId,
    recipientName: row.recipientName,
    recipientGstin: row.recipientGstin,
    taxableAmount: row.taxableAmount,
    cgstAmount: row.cgstAmount,
    sgstAmount: row.sgstAmount,
    igstAmount: row.igstAmount,
    totalAmount: row.totalAmount,
    currency: row.currency,
    status: row.status as TaxInvoiceDto["status"],
    issuedAt: row.issuedAt.toISOString(),
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function currentAgreementView(businessId: string): Promise<ComplianceAgreementView> {
  const [agreement] = await db.select().from(complianceAgreements).where(eq(complianceAgreements.version, COMPLIANCE_AGREEMENT_VERSION)).limit(1);
  const acceptance = agreement
    ? (await db.select().from(complianceAgreementAcceptances).where(and(eq(complianceAgreementAcceptances.businessId, businessId), eq(complianceAgreementAcceptances.agreementId, agreement.id))).limit(1))[0]
    : undefined;
  return {
    version: COMPLIANCE_AGREEMENT_VERSION,
    title: COMPLIANCE_AGREEMENT_TITLE,
    body: COMPLIANCE_AGREEMENT_BODY,
    contentHash: agreement?.contentHash ?? agreementContentHash(),
    effectiveAt: agreement?.effectiveAt.toISOString() ?? COMPLIANCE_AGREEMENT_EFFECTIVE_AT,
    accepted: Boolean(acceptance),
    acceptedAt: acceptance?.acceptedAt.toISOString() ?? null,
  };
}

function summaryFrom(row: ComplianceRow | undefined, documents: DocumentRow[], paired: boolean, agreement: ComplianceAgreementView): ComplianceSummary {
  const gstin = row?.gstin ?? "";
  const fssaiNumber = row?.fssaiNumber ?? "";
  const fssaiExpired = Boolean(row?.fssaiExpiresAt && isExpired(row.fssaiExpiresAt));
  const hasIdentity = hasKind(documents, "kyc_identity");
  const hasAddress = hasKind(documents, "kyc_address");
  const hasFssai = hasKind(documents, "fssai_license");
  const hasGst = hasKind(documents, "gst_registration");
  const taxRegime = (row?.taxRegime ?? "unregistered") as ComplianceSummary["taxRegime"];

  const kycStatus: ComplianceSummary["kycStatus"] = hasIdentity && hasAddress ? "submitted" : hasIdentity || hasAddress ? "needs_attention" : "not_submitted";
  const fssaiStatus: ComplianceSummary["fssaiStatus"] = fssaiExpired ? "expired" : hasFssai ? "submitted" : fssaiNumber ? "needs_attention" : "not_submitted";
  const taxStatus: ComplianceSummary["taxStatus"] = taxRegime === "unregistered"
    ? "not_applicable"
    : gstin && hasGst ? "submitted" : gstin || hasGst ? "needs_attention" : "not_submitted";

  const advisories: ComplianceSummary["advisories"] = [];
  if (!hasIdentity || !hasAddress) advisories.push({ key: "kyc", label: "KYC documents are incomplete", detail: "Add both identity and address proof. This is advisory only.", severity: "warning" });
  if (!fssaiNumber || !hasFssai) advisories.push({ key: "fssai", label: "FSSAI details are incomplete", detail: "Add the licence number and a readable copy.", severity: "warning" });
  if (fssaiExpired) advisories.push({ key: "fssai_expired", label: "FSSAI licence has expired", detail: "Upload a current licence when available.", severity: "warning" });
  if (taxRegime !== "unregistered" && (!gstin || !hasGst)) advisories.push({ key: "tax", label: "Tax registration is incomplete", detail: "Add the GSTIN and registration proof.", severity: "warning" });
  if (row?.payoutStatus !== "verified" && row?.payoutStatus !== "configured") advisories.push({ key: "payout", label: "Payout account is not confirmed", detail: "Payout setup is handled in Marketplace.", severity: "info" });
  if (!agreement.accepted) advisories.push({ key: "agreement", label: "Merchant agreement is not accepted", detail: "An owner can review and accept the current version.", severity: "info" });

  return {
    legalName: row?.legalName ?? "",
    entityType: row?.entityType ?? "",
    gstin,
    pan: row?.pan ?? "",
    taxRegime,
    taxInclusive: row?.taxInclusive ?? true,
    defaultTaxRateBps: row?.defaultTaxRateBps ?? 0,
    fssaiNumber,
    fssaiExpiresAt: row?.fssaiExpiresAt?.toISOString() ?? null,
    kycStatus,
    fssaiStatus,
    taxStatus,
    payoutStatus: row?.payoutStatus ?? "not_configured",
    payoutMethodLabel: row?.payoutMethodLabel ?? "",
    payoutReference: row?.payoutReference ?? "",
    payoutSyncedAt: row?.payoutSyncedAt?.toISOString() ?? null,
    paired,
    advisories,
    agreement,
  };
}

export async function loadComplianceOverview(businessId: string): Promise<ComplianceOverview> {
  const [row, documents, agreement, link] = await Promise.all([
    complianceRow(businessId), activeDocuments(businessId), currentAgreementView(businessId), getMarketplaceLink(businessId),
  ]);
  return {
    compliance: summaryFrom(row, documents, Boolean(link), agreement),
    documents: documents.map(documentDto),
    limits: { maxDocumentBytes: 10 * 1024 * 1024, allowedContentTypes: ["application/pdf", "image/png", "image/jpeg", "image/webp"] },
  };
}

export async function saveComplianceDetails(businessId: string, input: ComplianceInput) {
  const normalized = normalizeComplianceDetails(input);
  const keys = Object.keys(normalized) as (keyof typeof normalized)[];
  if (keys.length === 0) throw new ApiError("No compliance details were provided.", 400);
  const current = await complianceRow(businessId);
  const candidate = {
    gstin: normalized.gstin ?? current?.gstin ?? "",
    taxRegime: normalized.taxRegime ?? (current?.taxRegime as ComplianceSummary["taxRegime"] ?? "unregistered"),
  };
  assertComplianceConsistency(candidate);

  const patch: Partial<typeof businessCompliance.$inferInsert> = { updatedAt: new Date() };
  if (normalized.legalName !== undefined) patch.legalName = normalized.legalName;
  if (normalized.entityType !== undefined) patch.entityType = normalized.entityType;
  if (normalized.gstin !== undefined) patch.gstin = normalized.gstin;
  if (normalized.pan !== undefined) patch.pan = normalized.pan;
  if (normalized.taxRegime !== undefined) patch.taxRegime = normalized.taxRegime;
  if (normalized.taxInclusive !== undefined) patch.taxInclusive = normalized.taxInclusive;
  if (normalized.defaultTaxRateBps !== undefined) patch.defaultTaxRateBps = normalized.defaultTaxRateBps;
  if (normalized.fssaiNumber !== undefined) patch.fssaiNumber = normalized.fssaiNumber;
  if (normalized.fssaiExpiresAt !== undefined) patch.fssaiExpiresAt = normalized.fssaiExpiresAt === null ? null : expiryDateToDate(normalized.fssaiExpiresAt);

  const values = { businessId, ...patch };
  await db.insert(businessCompliance).values(values).onConflictDoUpdate({ target: businessCompliance.businessId, set: patch });
  return loadComplianceOverview(businessId);
}

async function touchComplianceStatuses(businessId: string, patch: Partial<typeof businessCompliance.$inferInsert>) {
  await db.update(businessCompliance).set({ ...patch, updatedAt: new Date() }).where(eq(businessCompliance.businessId, businessId));
}

export async function listComplianceDocuments(businessId: string) {
  return (await activeDocuments(businessId)).map(documentDto);
}

export async function findComplianceDocument(businessId: string, id: string) {
  if (!UUID.test(id)) return undefined;
  const [row] = await db.select().from(complianceDocuments).where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.businessId, businessId))).limit(1);
  return row;
}

export async function insertComplianceDocument(input: {
  businessId: string;
  kind: ComplianceDocumentKind;
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
  expiresAt: string | null;
  uploadedBy: string;
}) {
  const [row] = await db.insert(complianceDocuments).values({
    businessId: input.businessId,
    kind: input.kind,
    fileName: input.fileName,
    contentType: input.contentType,
    byteSize: input.byteSize,
    sha256: input.sha256,
    storageKey: input.storageKey,
    expiresAt: input.expiresAt ? expiryDateToDate(input.expiresAt) : null,
    uploadedBy: input.uploadedBy,
  }).returning();
  if (input.kind === "kyc_identity" || input.kind === "kyc_address") await touchComplianceStatuses(input.businessId, { kycStatus: "submitted" });
  if (input.kind === "fssai_license") await touchComplianceStatuses(input.businessId, { fssaiStatus: input.expiresAt && isExpired(expiryDateToDate(input.expiresAt)) ? "expired" : "submitted" });
  if (input.kind === "gst_registration" || input.kind === "pan_card") await touchComplianceStatuses(input.businessId, { taxStatus: "submitted" });
  return documentDto(row);
}

export async function deleteComplianceDocument(businessId: string, id: string) {
  if (!UUID.test(id)) throw new ApiError("Invalid document id.", 400);
  const deleted = await db.delete(complianceDocuments)
    .where(and(eq(complianceDocuments.id, id), eq(complianceDocuments.businessId, businessId)))
    .returning({ storageKey: complianceDocuments.storageKey, kind: complianceDocuments.kind });
  const row = deleted[0];
  if (!row) throw new ApiError("Document not found.", 404);
  const remaining = await activeDocuments(businessId);
  if (row.kind === "kyc_identity" || row.kind === "kyc_address") {
    await touchComplianceStatuses(businessId, { kycStatus: remaining.some((document) => document.kind === "kyc_identity" || document.kind === "kyc_address") ? "submitted" : "not_submitted" });
  }
  if (row.kind === "fssai_license") {
    await touchComplianceStatuses(businessId, { fssaiStatus: remaining.some((document) => document.kind === "fssai_license") ? "submitted" : "not_submitted" });
  }
  return row.storageKey;
}

export async function acceptCurrentAgreement(businessId: string, userId: string, input: unknown, metadata: { ipHash: string; userAgentHash: string } = { ipHash: "", userAgentHash: "" }) {
  const body = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (body.accepted !== true) throw new ApiError("You must accept the current agreement.", 400);
  if (body.version !== COMPLIANCE_AGREEMENT_VERSION || body.contentHash !== agreementContentHash()) {
    throw new ApiError("The agreement changed. Review the current version and try again.", 409);
  }
  await db.insert(complianceAgreements).values({
    version: COMPLIANCE_AGREEMENT_VERSION,
    title: COMPLIANCE_AGREEMENT_TITLE,
    body: COMPLIANCE_AGREEMENT_BODY,
    contentHash: agreementContentHash(),
    effectiveAt: new Date(COMPLIANCE_AGREEMENT_EFFECTIVE_AT),
    publishedAt: new Date(),
  }).onConflictDoNothing({ target: complianceAgreements.version });
  const [agreement] = await db.select().from(complianceAgreements).where(eq(complianceAgreements.version, COMPLIANCE_AGREEMENT_VERSION)).limit(1);
  if (!agreement) throw new ApiError("The agreement could not be loaded.", 503);
  await db.insert(complianceAgreementAcceptances).values({
    businessId, agreementId: agreement.id, userId,
    ipHash: metadata.ipHash, userAgentHash: metadata.userAgentHash,
  }).onConflictDoNothing({ target: [complianceAgreementAcceptances.businessId, complianceAgreementAcceptances.agreementId] });
  return currentAgreementView(businessId);
}

async function optionalMarketplaceFetch<T>(businessId: string, path: string, init: RequestInit = {}): Promise<T | null> {
  try { return await marketplaceFetch<T>(businessId, path, init); }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

function parseOrThrow<T>(payload: unknown, parser: (payload: unknown) => T, label: string): T {
  try { return parser(payload); }
  catch (error) {
    if (error instanceof Error) throw new ApiError(`Marketplace returned an invalid ${label}.`, 502);
    throw error;
  }
}

async function savePayoutMirror(businessId: string, remote: RemotePayout, fallbackLabel = "") {
  const patch: Partial<typeof businessCompliance.$inferInsert> = {
    payoutStatus: remote.status,
    payoutMethodLabel: remote.methodLabel || fallbackLabel,
    payoutReference: remote.reference,
    payoutSyncedAt: new Date(remote.updatedAt),
    updatedAt: new Date(),
  };
  await db.insert(businessCompliance).values({ businessId, ...patch }).onConflictDoUpdate({ target: businessCompliance.businessId, set: patch });
}

function localPayoutView(row: ComplianceRow | undefined, message: string, available: boolean, authoritative: boolean): CompliancePayoutView {
  return {
    available,
    authoritative,
    status: row?.payoutStatus ?? "not_configured",
    methodLabel: row?.payoutMethodLabel ?? "",
    reference: row?.payoutReference ?? "",
    syncedAt: row?.payoutSyncedAt?.toISOString() ?? null,
    message,
  };
}

export async function loadPayoutView(businessId: string): Promise<CompliancePayoutView> {
  const [row, link] = await Promise.all([complianceRow(businessId), getMarketplaceLink(businessId)]);
  if (!link) return localPayoutView(row, "Connect this outlet to Marketplace to manage payout details.", false, false);
  const payload = await optionalMarketplaceFetch<unknown>(businessId, PAYOUT_PATH);
  if (payload === null) return localPayoutView(row, "Marketplace does not expose payout status on this deployment. Showing the last mirrored state.", false, false);
  const remote = parseOrThrow(payload, parseRemotePayout, "payout status");
  await savePayoutMirror(businessId, remote, row?.payoutMethodLabel ?? "");
  return {
    available: true,
    authoritative: true,
    status: remote.status,
    methodLabel: remote.methodLabel || row?.payoutMethodLabel || "",
    reference: remote.reference || row?.payoutReference || "",
    syncedAt: remote.updatedAt,
    message: "Payout status is authoritative in Marketplace.",
  };
}

export async function submitPayoutDetails(businessId: string, input: unknown): Promise<CompliancePayoutView> {
  const link = await getMarketplaceLink(businessId);
  if (!link) throw new ApiError("Connect this outlet to Marketplace before configuring payouts.", 409);
  const normalized = normalizePayoutInput(input);
  const masked = maskPayout(normalized);
  let payload: unknown;
  try {
    payload = await marketplaceFetch<unknown>(businessId, PAYOUT_PATH, { method: "POST", body: JSON.stringify(normalized) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new ApiError("Marketplace does not expose payout setup on this deployment.", 503);
    throw error;
  }
  const remote = parseOrThrow(payload, parseRemotePayout, "payout response");
  await savePayoutMirror(businessId, remote, masked);
  return loadPayoutView(businessId);
}

export async function listInvoices(businessId: string, options: { limit: number; offset: number; source?: "marketplace" | "proforma" }) {
  const conditions = [eq(taxInvoices.businessId, businessId)];
  if (options.source) conditions.push(eq(taxInvoices.source, options.source));
  const rows = await db.select().from(taxInvoices).where(and(...conditions)).orderBy(desc(taxInvoices.issuedAt)).limit(options.limit + 1).offset(options.offset);
  return { invoices: rows.slice(0, options.limit).map(invoiceDto), hasMore: rows.length > options.limit };
}

function validCalendarDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(`${label} must use YYYY-MM-DD.`, 400);
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new ApiError(`${label} must be a real calendar date.`, 400);
  return value;
}

export async function syncMarketplaceInvoices(businessId: string, input: { from?: unknown; to?: unknown } = {}) {
  const link = await getMarketplaceLink(businessId);
  if (!link) throw new ApiError("Only paired outlets can sync Marketplace invoices.", 409);
  const from = validCalendarDate(input.from, "From date");
  const to = validCalendarDate(input.to, "To date");
  if (from && to && from > to) throw new ApiError("From date must be before To date.", 400);
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const path = query.size ? `${INVOICES_PATH}?${query.toString()}` : INVOICES_PATH;
  const payload = await optionalMarketplaceFetch<unknown>(businessId, path);
  if (payload === null) return { available: false, received: 0, applied: 0, skipped: 0, message: "Marketplace does not expose invoices on this deployment." };
  const remote = parseOrThrow(payload, parseRemoteInvoiceFeed, "invoice feed");
  const unique = new Map(remote.map((row) => [row.invoiceNumber, row]));
  const numbers = [...unique.keys()];
  const existing = numbers.length
    ? await db.select().from(taxInvoices).where(and(eq(taxInvoices.businessId, businessId), inArray(taxInvoices.invoiceNumber, numbers)))
    : [];
  const byNumber = new Map(existing.map((row) => [row.invoiceNumber, row]));
  let applied = 0;
  let skipped = 0;
  for (const row of unique.values()) {
    const current = byNumber.get(row.invoiceNumber);
    const sourceUpdatedAt = new Date(row.updatedAt);
    if (current) {
      const currentVersion = current.sourceUpdatedAt?.getTime() ?? current.issuedAt.getTime();
      if (currentVersion >= sourceUpdatedAt.getTime()) { skipped++; continue; }
      const updated = await db.update(taxInvoices).set({
        source: "marketplace",
        externalId: row.externalId,
        orderId: row.orderId,
        recipientName: row.recipientName,
        recipientGstin: row.recipientGstin,
        taxableAmount: row.taxableAmount,
        cgstAmount: row.cgstAmount,
        sgstAmount: row.sgstAmount,
        igstAmount: row.igstAmount,
        totalAmount: row.totalAmount,
        currency: row.currency,
        status: row.status,
        issuedAt: new Date(row.issuedAt),
        sourceUpdatedAt,
        updatedAt: new Date(),
      }).where(and(eq(taxInvoices.id, current.id), or(isNull(taxInvoices.sourceUpdatedAt), lt(taxInvoices.sourceUpdatedAt, sourceUpdatedAt)))).returning({ id: taxInvoices.id });
      if (updated.length) applied++; else skipped++;
      continue;
    }
    await db.insert(taxInvoices).values({
      businessId,
      invoiceNumber: row.invoiceNumber,
      source: "marketplace",
      externalId: row.externalId,
      orderId: row.orderId,
      recipientName: row.recipientName,
      recipientGstin: row.recipientGstin,
      taxableAmount: row.taxableAmount,
      cgstAmount: row.cgstAmount,
      sgstAmount: row.sgstAmount,
      igstAmount: row.igstAmount,
      totalAmount: row.totalAmount,
      currency: row.currency,
      status: row.status,
      issuedAt: new Date(row.issuedAt),
      sourceUpdatedAt,
    }).onConflictDoNothing({ target: [taxInvoices.businessId, taxInvoices.invoiceNumber] });
    applied++;
  }
  return { available: true, received: remote.length, applied, skipped };
}

export async function createProFormaInvoice(businessId: string, orderIdValue: unknown) {
  const link = await getMarketplaceLink(businessId);
  if (link) throw new ApiError("Paired outlets mirror Marketplace invoices; pro forma documents are only for unpaired outlets.", 409);
  if (typeof orderIdValue !== "string" || !UUID.test(orderIdValue)) throw new ApiError("Choose a valid completed order.", 400);
  const [existing] = await db.select().from(taxInvoices).where(and(eq(taxInvoices.businessId, businessId), eq(taxInvoices.externalId, orderIdValue), eq(taxInvoices.source, "proforma"))).limit(1);
  if (existing) return invoiceDto(existing);

  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderIdValue), eq(orders.businessId, businessId))).limit(1);
  if (!order || order.status !== "completed") throw new ApiError("Only completed local orders can produce a pro forma document.", 404);
  const [row] = await Promise.all([complianceRow(businessId)]);
  const rateBps = row?.defaultTaxRateBps ?? 0;
  const inclusive = row?.taxInclusive ?? true;
  const taxableAmount = inclusive ? Math.round(order.total * 10_000 / (10_000 + rateBps)) : order.total;
  const taxTotal = inclusive ? order.total - taxableAmount : Math.round(order.total * rateBps / 10_000);
  const totalAmount = inclusive ? order.total : taxableAmount + taxTotal;
  const cgstAmount = Math.ceil(taxTotal / 2);
  const [created] = await db.insert(taxInvoices).values({
    businessId,
    invoiceNumber: `PF-${order.orderNumber}-${order.id.slice(0, 8).toUpperCase()}`,
    source: "proforma",
    externalId: order.id,
    orderId: String(order.orderNumber),
    recipientName: order.customerName,
    recipientGstin: "",
    taxableAmount,
    cgstAmount,
    sgstAmount: taxTotal - cgstAmount,
    igstAmount: 0,
    totalAmount,
    currency: "INR",
    status: "proforma",
    issuedAt: order.createdAt,
  }).returning();
  return invoiceDto(created);
}

export async function findInvoice(businessId: string, id: string) {
  if (!UUID.test(id)) return undefined;
  const [row] = await db.select().from(taxInvoices).where(and(eq(taxInvoices.id, id), eq(taxInvoices.businessId, businessId))).limit(1);
  return row;
}

export async function invoicePdfContext(businessId: string) {
  const [business, row] = await Promise.all([
    db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
    complianceRow(businessId),
  ]);
  return { businessName: business[0]?.name ?? "Merchant outlet", gstin: row?.gstin ?? "" };
}
