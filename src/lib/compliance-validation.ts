/**
 * Pure compliance rules shared by API routes and standalone tests.
 *
 * These checks are deliberately narrow: format, calendar expiry, file MIME/magic
 * bytes and size only. They never call an external registry and never claim that
 * a submitted document or payout account was verified.
 */

import { createHash } from "node:crypto";
import type {
  ComplianceDocumentKind, ComplianceInput, InvoiceStatus, PayoutStatus,
  RemoteInvoice, RemotePayout, TaxRegime,
} from "./types";

export class ComplianceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceValidationError";
  }
}

function fail(message: string): never {
  throw new ComplianceValidationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${label} must be text.`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) fail(`${label} must be at most ${max} characters.`);
  return text;
}

function requiredText(value: unknown, max: number, label: string): string {
  const text = optionalText(value, max, label);
  if (!text) fail(`${label} is required.`);
  return text;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be a whole number.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const result = integer(value, label);
  if (result < 0) fail(`${label} cannot be negative.`);
  return result;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) fail(`${label} must be an ISO date.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`${label} must be an ISO date.`);
  return parsed.toISOString();
}

export const COMPLIANCE_DOCUMENT_KINDS = [
  "kyc_identity", "kyc_address", "fssai_license", "gst_registration", "pan_card", "bank_proof",
] as const satisfies readonly ComplianceDocumentKind[];

export const DOCUMENT_KIND_LABELS: Record<ComplianceDocumentKind, string> = {
  kyc_identity: "KYC identity proof",
  kyc_address: "KYC address proof",
  fssai_license: "FSSAI licence",
  gst_registration: "GST registration",
  pan_card: "PAN card",
  bank_proof: "Payout account proof",
};

/** Expiry-bearing kinds are flagged when stale, but never block an upload. */
export const DOCUMENT_KIND_EXPIRY: Record<ComplianceDocumentKind, boolean> = {
  kyc_identity: false,
  kyc_address: false,
  fssai_license: true,
  gst_registration: false,
  pan_card: false,
  bank_proof: false,
};

export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  "application/pdf", "image/png", "image/jpeg", "image/webp",
] as const;

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TAX_RATE_BPS = 2800;
export const TAX_REGIMES: readonly TaxRegime[] = ["unregistered", "regular", "composition"];
export const PAYOUT_STATUSES: readonly PayoutStatus[] = ["not_configured", "pending", "configured", "verified", "action_required"];
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["issued", "proforma", "cancelled", "void"];

export const COMPLIANCE_AGREEMENT_VERSION = "2026-11-01";
export const COMPLIANCE_AGREEMENT_TITLE = "Savour Merchant Compliance and Payout Agreement";
export const COMPLIANCE_AGREEMENT_EFFECTIVE_AT = "2026-11-01T00:00:00.000Z";
export const COMPLIANCE_AGREEMENT_BODY = [
  "This agreement explains how merchant compliance records and payout details are handled.",
  "You confirm that the registration details and documents you provide are your own and accurate.",
  "Savour checks only file format, expiry and basic document metadata. Submission is not verification.",
  "Missing compliance items are advisory and do not by themselves block orders or payouts.",
  "Bank and UPI payout details are submitted directly to the Marketplace, which remains authoritative.",
  "The Merchant App stores only a masked payout label and a Marketplace reference, never raw account details.",
  "Marketplace-issued tax invoices are mirrored for viewing. Unpaired outlets can issue clearly labelled pro forma documents only.",
].join("\n");

export function agreementContentHash(): string {
  return createHash("sha256").update([
    COMPLIANCE_AGREEMENT_VERSION,
    COMPLIANCE_AGREEMENT_TITLE,
    COMPLIANCE_AGREEMENT_BODY,
  ].join("\n")).digest("hex");
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const FSSAI = /^[0-9]{14}$/;
const UPI = /^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const CURRENCY = /^[A-Z]{3}$/;

function compactIdentifier(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${label} must be text.`);
  const text = value.replace(/[\s-]/g, "");
  if (text.length > max) fail(`${label} must be at most ${max} characters.`);
  return text;
}

export function normalizeGstin(value: unknown): string | undefined {
  const text = compactIdentifier(value, 20, "GSTIN")?.toUpperCase();
  if (text === undefined || text === "") return text;
  if (!GSTIN.test(text)) fail("Enter a valid 15-character GSTIN.");
  return text;
}

export function normalizePan(value: unknown): string | undefined {
  const text = compactIdentifier(value, 20, "PAN")?.toUpperCase();
  if (text === undefined || text === "") return text;
  if (!PAN.test(text)) fail("Enter a valid 10-character PAN.");
  return text;
}

export function normalizeFssaiNumber(value: unknown): string | undefined {
  const text = compactIdentifier(value, 20, "FSSAI number");
  if (text === undefined || text === "") return text;
  if (!FSSAI.test(text)) fail("Enter a valid 14-digit FSSAI number.");
  return text;
}

export function parseExpiryDate(value: unknown, label = "Expiry date"): string | undefined {
  const text = optionalText(value, 10, label);
  if (text === undefined || text === "") return text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} must use YYYY-MM-DD.`);
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`${label} must be a real calendar date.`);
  }
  return text;
}

/** Expiry dates are inclusive through the end of that date in Asia/Kolkata. */
export function expiryDateToDate(value: string): Date {
  const parsed = parseExpiryDate(value);
  if (!parsed) fail("Expiry date is required.");
  return new Date(`${parsed}T23:59:59.999+05:30`);
}

export function isExpired(value: string | Date | null | undefined, now = new Date()): boolean {
  if (!value) return false;
  const date = typeof value === "string" ? new Date(value) : value;
  return !Number.isNaN(date.getTime()) && date.getTime() < now.getTime();
}

export type NormalizedComplianceDetails = {
  legalName?: string;
  entityType?: string;
  gstin?: string;
  pan?: string;
  taxRegime?: TaxRegime;
  taxInclusive?: boolean;
  defaultTaxRateBps?: number;
  fssaiNumber?: string;
  fssaiExpiresAt?: string | null;
};

export function normalizeComplianceDetails(value: unknown): NormalizedComplianceDetails {
  const input = object(value, "Compliance details");
  const result: NormalizedComplianceDetails = {};
  const legalName = optionalText(input.legalName, 200, "Legal name");
  if (legalName !== undefined) result.legalName = legalName;
  const entityType = optionalText(input.entityType, 80, "Entity type");
  if (entityType !== undefined) result.entityType = entityType;
  const gstin = normalizeGstin(input.gstin);
  if (gstin !== undefined) result.gstin = gstin;
  const pan = normalizePan(input.pan);
  if (pan !== undefined) result.pan = pan;
  const fssaiNumber = normalizeFssaiNumber(input.fssaiNumber);
  if (fssaiNumber !== undefined) result.fssaiNumber = fssaiNumber;
  if (input.taxRegime !== undefined) {
    if (typeof input.taxRegime !== "string" || !TAX_REGIMES.includes(input.taxRegime as TaxRegime)) {
      fail("Choose a valid tax regime.");
    }
    result.taxRegime = input.taxRegime as TaxRegime;
  }
  if (input.taxInclusive !== undefined) {
    if (typeof input.taxInclusive !== "boolean") fail("Tax inclusive must be true or false.");
    result.taxInclusive = input.taxInclusive;
  }
  if (input.defaultTaxRateBps !== undefined) {
    const rate = integer(input.defaultTaxRateBps, "Default tax rate");
    if (rate < 0 || rate > MAX_TAX_RATE_BPS) fail("Default tax rate must be between 0 and 28 percent.");
    result.defaultTaxRateBps = rate;
  }
  if (input.fssaiExpiresAt !== undefined) {
    if (input.fssaiExpiresAt === null || input.fssaiExpiresAt === "") result.fssaiExpiresAt = null;
    else result.fssaiExpiresAt = parseExpiryDate(input.fssaiExpiresAt);
  }
  return result;
}

export function assertComplianceConsistency(details: { gstin: string; taxRegime: TaxRegime }): void {
  if (details.gstin && details.taxRegime === "unregistered") fail("Choose a registered tax regime when adding a GSTIN.");
  if (!details.gstin && details.taxRegime !== "unregistered") fail("Add a GSTIN for a registered tax regime.");
}

function magicMatches(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "application/pdf") return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
  if (contentType === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/webp") return bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP";
  return false;
}

export function validateDocumentFile(input: { kind: unknown; contentType: unknown; bytes: Uint8Array; expiresAt?: unknown }) {
  if (typeof input.kind !== "string" || !(COMPLIANCE_DOCUMENT_KINDS as readonly string[]).includes(input.kind)) {
    fail("Choose a supported document kind.");
  }
  const kind = input.kind as ComplianceDocumentKind;
  if (typeof input.contentType !== "string") fail("The file type could not be determined.");
  const contentType = input.contentType.toLowerCase().split(";")[0].trim();
  if (!(ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    fail("Upload a PDF, PNG, JPEG or WebP file.");
  }
  if (input.bytes.length === 0) fail("The file is empty.");
  if (input.bytes.length > MAX_DOCUMENT_BYTES) fail(`Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller.`);
  if (!magicMatches(contentType, input.bytes)) fail("The file contents do not match its file type.");
  const expiry = DOCUMENT_KIND_EXPIRY[kind] ? parseExpiryDate(input.expiresAt, "Document expiry") : undefined;
  return {
    kind,
    contentType,
    byteSize: input.bytes.length,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    expiresAt: expiry ?? null,
  };
}

export type NormalizedPayoutInput =
  | { method: "upi"; upiId: string }
  | { method: "bank"; accountHolderName: string; accountNumber: string; ifsc: string };

export function normalizePayoutInput(value: unknown): NormalizedPayoutInput {
  const input = object(value, "Payout details");
  if (input.method === "upi") {
    const upiId = requiredText(input.upiId, 120, "UPI ID");
    if (!UPI.test(upiId)) fail("Enter a valid UPI ID.");
    return { method: "upi", upiId };
  }
  if (input.method === "bank") {
    const accountHolderName = requiredText(input.accountHolderName, 120, "Account holder name");
    const accountNumber = requiredText(input.accountNumber, 20, "Account number");
    const ifsc = requiredText(input.ifsc, 20, "IFSC").toUpperCase();
    if (!/^\d{9,18}$/.test(accountNumber)) fail("Enter a valid account number.");
    if (!IFSC.test(ifsc)) fail("Enter a valid IFSC.");
    return { method: "bank", accountHolderName, accountNumber, ifsc };
  }
  fail("Choose UPI or bank as the payout method.");
}

/** Never store raw account numbers locally; this masked label is safe to mirror. */
export function maskPayout(input: NormalizedPayoutInput): string {
  if (input.method === "upi") {
    const [local, domain] = input.upiId.split("@");
    return `UPI ${local.slice(0, 2)}***@${domain}`;
  }
  return `Bank ••••${input.accountNumber.slice(-4)} (${input.ifsc})`;
}

export function parseRemotePayout(payload: unknown): RemotePayout {
  const root = object(payload, "Payout response");
  const row = object(root.payout ?? root, "Payout response");
  const status = row.status;
  if (typeof status !== "string" || !PAYOUT_STATUSES.includes(status as PayoutStatus)) fail("Marketplace returned an invalid payout status.");
  return {
    status: status as PayoutStatus,
    methodLabel: optionalText(row.methodLabel ?? row.label ?? row.maskedLabel, 120, "Payout method") ?? "",
    reference: optionalText(row.reference ?? row.externalId, 200, "Payout reference") ?? "",
    updatedAt: isoDate(row.updatedAt ?? row.syncedAt ?? row.createdAt, "Payout update time"),
  };
}

function amount(value: Record<string, unknown>, keys: string[], label: string, fallback = 0): number {
  for (const key of keys) {
    if (value[key] !== undefined) return nonNegativeInteger(value[key], label);
  }
  return fallback;
}

function remoteInvoice(rowValue: unknown): RemoteInvoice {
  const row = object(rowValue, "Invoice");
  const invoiceNumber = requiredText(row.invoiceNumber ?? row.number, 120, "Invoice number");
  const currency = (optionalText(row.currency, 3, "Currency") ?? "INR").toUpperCase();
  if (!CURRENCY.test(currency)) fail("Invoice currency must be a three-letter code.");
  const status = (optionalText(row.status, 20, "Invoice status") ?? "issued") as InvoiceStatus;
  if (!INVOICE_STATUSES.includes(status)) fail("Marketplace returned an invalid invoice status.");
  const issuedAt = isoDate(row.issuedAt ?? row.createdAt, "Invoice issue time");
  const recipientGstin = normalizeGstin(row.recipientGstin ?? row.gstin) ?? "";
  return {
    externalId: optionalText(row.externalId ?? row.id, 200, "Invoice external ID") ?? invoiceNumber,
    invoiceNumber,
    orderId: optionalText(row.orderId ?? row.marketplaceOrderId, 120, "Invoice order") ?? "",
    recipientName: optionalText(row.recipientName ?? row.customerName, 200, "Invoice recipient") ?? "",
    recipientGstin,
    taxableAmount: amount(row, ["taxableAmount", "taxablePaise", "taxable"], "Taxable amount"),
    cgstAmount: amount(row, ["cgstAmount", "cgstPaise", "cgst"], "CGST"),
    sgstAmount: amount(row, ["sgstAmount", "sgstPaise", "sgst"], "SGST"),
    igstAmount: amount(row, ["igstAmount", "igstPaise", "igst"], "IGST"),
    totalAmount: amount(row, ["totalAmount", "totalPaise", "total"], "Invoice total"),
    currency,
    status,
    issuedAt,
    updatedAt: row.updatedAt === undefined ? issuedAt : isoDate(row.updatedAt, "Invoice update time"),
  };
}

export function parseRemoteInvoiceFeed(payload: unknown): RemoteInvoice[] {
  const root = object(payload, "Invoice response");
  const rows = root.invoices ?? root.data;
  if (!Array.isArray(rows)) fail("Marketplace invoice feed must contain an invoices array.");
  if (rows.length > 500) fail("Marketplace invoice feed contains too many records.");
  return rows.map(remoteInvoice);
}

export function normalizeComplianceInput(value: unknown): ComplianceInput {
  return normalizeComplianceDetails(value);
}
