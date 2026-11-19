/**
 * Minimal, dependency-free PDF writer for compliance invoice records.
 *
 * Paired rows are labelled as mirrors rather than original Marketplace invoices;
 * unpaired rows are labelled pro forma and are not tax invoices.
 */

import type { TaxInvoiceDto } from "./types";

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

function escapePdf(value: string): string {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function rupees(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}

export function buildInvoicePdf(invoice: TaxInvoiceDto, businessName: string, gstin: string): Uint8Array {
  const mirror = invoice.source === "marketplace";
  const title = mirror ? "MARKETPLACE INVOICE MIRROR" : "PRO FORMA INVOICE";
  const notice = mirror
    ? "Merchant-generated mirror of Marketplace metadata. Not the original tax invoice."
    : "Pro forma document only. Not a GST tax invoice and not proof of payment.";
  const lines = [
    title,
    notice,
    "",
    `Outlet: ${businessName}`,
    `Invoice number: ${invoice.invoiceNumber}`,
    `Date: ${invoice.issuedAt.slice(0, 10)}`,
    `Status: ${invoice.status}`,
    "",
    `Recipient: ${invoice.recipientName || "Guest"}`,
    `Recipient GSTIN: ${invoice.recipientGstin || "Not supplied"}`,
    `Seller GSTIN: ${gstin || "Not supplied"}`,
    "",
    `Taxable amount: ${rupees(invoice.taxableAmount)}`,
    `CGST: ${rupees(invoice.cgstAmount)}`,
    `SGST: ${rupees(invoice.sgstAmount)}`,
    `IGST: ${rupees(invoice.igstAmount)}`,
    `Total: ${rupees(invoice.totalAmount)} ${invoice.currency}`,
    "",
    mirror ? "Source: Marketplace. Verify the original in your Marketplace account." : "Generated from local order data for an unpaired outlet.",
  ];
  const stream = `BT\n/F1 11 Tf\n14 TL\n50 790 Td\n${lines.map((line) => `(${escapePdf(line)}) Tj T*`).join("\n")}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(pdf, "latin1"));
}
