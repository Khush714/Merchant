import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_DOCUMENT_BYTES,
  agreementContentHash,
  assertComplianceConsistency,
  expiryDateToDate,
  isExpired,
  maskPayout,
  normalizeComplianceDetails,
  normalizeFssaiNumber,
  normalizeGstin,
  normalizePan,
  normalizePayoutInput,
  parseExpiryDate,
  parseRemoteInvoiceFeed,
  parseRemotePayout,
  validateDocumentFile,
} from "../src/lib/compliance-validation.ts";

assert.match(agreementContentHash(), /^[a-f0-9]{64}$/);
assert.equal(agreementContentHash(), agreementContentHash(), "the agreement hash must be stable");

assert.equal(normalizeGstin("27aapfu0939f1zv"), "27AAPFU0939F1ZV");
assert.throws(() => normalizeGstin("27AAPFU0939F1Z"), /valid 15-character GSTIN/);
assert.equal(normalizePan("atppb1234k"), "ATPPB1234K");
assert.throws(() => normalizePan("ATPPB1234"), /valid 10-character PAN/);
assert.equal(normalizeFssaiNumber("1 1 4 2 2 9 9 0 0 0 0 6 7 8"), "11422990000678");
assert.throws(() => normalizeFssaiNumber("123"), /14-digit/);

assert.equal(parseExpiryDate("2027-02-28"), "2027-02-28");
assert.throws(() => parseExpiryDate("2027-02-29"), /real calendar date/);
assert.equal(expiryDateToDate("2027-02-28").toISOString(), "2027-02-28T18:29:59.999Z");
assert.equal(isExpired("2020-01-01T00:00:00Z", new Date("2026-11-19T00:00:00Z")), true);
assert.equal(isExpired("2030-01-01T00:00:00Z", new Date("2026-11-19T00:00:00Z")), false);

const pdf = Buffer.from("%PDF-1.4\nmerchant compliance", "latin1");
const checked = validateDocumentFile({ kind: "fssai_license", contentType: "application/pdf", bytes: pdf, expiresAt: "2027-02-28" });
assert.equal(checked.contentType, "application/pdf");
assert.equal(checked.byteSize, pdf.length);
assert.equal(checked.expiresAt, "2027-02-28");
assert.match(checked.sha256, /^[a-f0-9]{64}$/);
assert.throws(() => validateDocumentFile({ kind: "fssai_license", contentType: "image/png", bytes: pdf }), /contents do not match/);
assert.throws(() => validateDocumentFile({ kind: "kyc_identity", contentType: "application/pdf", bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) }), /smaller/);

const details = normalizeComplianceDetails({
  legalName:  "  Verde Kitchen  ",
  gstin: "27AAPFU0939F1ZV",
  taxRegime: "regular",
  taxInclusive: true,
  defaultTaxRateBps: 500,
  fssaiExpiresAt: "2027-02-28",
});
assert.equal(details.legalName, "Verde Kitchen");
assert.equal(details.defaultTaxRateBps, 500);
assert.doesNotThrow(() => assertComplianceConsistency({ gstin: details.gstin, taxRegime: details.taxRegime }));
assert.throws(() => assertComplianceConsistency({ gstin: "", taxRegime: "regular" }), /Add a GSTIN/);

const upi = normalizePayoutInput({ method: "upi", upiId: "merchant@bank" });
assert.equal(maskPayout(upi), "UPI me***@bank");
assert.equal(maskPayout(upi).includes("merchant@bank"), false, "raw UPI IDs must not be stored");
const bank = normalizePayoutInput({ method: "bank", accountHolderName: "Verde Kitchen", accountNumber: "1234567890", ifsc: "HDFC0001234" });
assert.equal(maskPayout(bank), "Bank ••••7890 (HDFC0001234)");
assert.throws(() => normalizePayoutInput({ method: "bank", accountHolderName: "Verde Kitchen", accountNumber: "123", ifsc: "BAD" }), /valid account number/);

const payout = parseRemotePayout({ payout: { status: "verified", methodLabel: "UPI ••••@bank", reference: "pay_1", updatedAt: "2026-11-19T10:00:00Z" } });
assert.equal(payout.status, "verified");
assert.equal(payout.reference, "pay_1");
assert.throws(() => parseRemotePayout({ status: "magic" }), /invalid payout status/);

const invoices = parseRemoteInvoiceFeed({ invoices: [{
  externalId: "inv_1",
  invoiceNumber: "MP/2026/1",
  marketplaceOrderId: "order-1",
  recipientName: "Guest",
  taxablePaise: 10000,
  cgstPaise: 250,
  sgstPaise: 250,
  totalPaise: 10500,
  issuedAt: "2026-11-18T10:00:00Z",
  updatedAt: "2026-11-18T11:00:00Z",
}] });
assert.equal(invoices[0].invoiceNumber, "MP/2026/1");
assert.equal(invoices[0].orderId, "order-1");
assert.equal(invoices[0].totalAmount, 10500);
assert.throws(() => parseRemoteInvoiceFeed({ invoices: [{ invoiceNumber: "bad", status: "paid" }] }), /invalid invoice status/);

// KPI cards highlight completed work with green text and a tick; incomplete work keeps the warning tag.
const cardSource = readFileSync(new URL("../src/components/compliance.tsx", import.meta.url), "utf8");
assert.match(cardSource, /DONE_STATUSES = new Set\(\["submitted", "not_applicable"\]\)/);
assert.match(cardSource, /DONE_PAYOUT_STATUSES = new Set\(\["configured", "verified"\]\)/);
assert.match(cardSource, /className=\{`approval-tag\$\{done \? " done" : ""\}`\}/);
assert.match(cardSource, /done && <CheckCircle2 size=\{12\} aria-hidden="true" \/>/);
assert.match(cardSource, /statusTag\(summary\.agreement\.accepted \? "Accepted" : "Not accepted", summary\.agreement\.accepted\)/);
const cardCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
assert.match(cardCss, /\.approval-tag\.done\{[^}]*color:#1f7a4d/);

console.log("PASS: compliance validation, Marketplace parsers and KPI status tags");
