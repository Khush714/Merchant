/** Dependency-free PDF writer for merchant-generated settlement statements. */
import type { StatementDetail } from "./types";

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}
function escapePdf(value: string): string {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function rupees(paise: number): string {
  return `Rs ${(paise / 100).toFixed(2)}`;
}

export function buildStatementPdf(statement: StatementDetail, businessName: string): Uint8Array {
  const lines = [
    "RESTAURANT SETTLEMENT STATEMENT",
    "Merchant-generated statement from mirrored Marketplace settlements.",
    "Not a bank statement or tax invoice. Settlement paidAt is capture time, not bank payout time.",
    "",
    `Outlet: ${businessName}`,
    `Statement number: ${statement.number}`,
    `Period: ${statement.periodFrom} to ${statement.periodTo}`,
    `Settlement lines: ${statement.lineCount}`,
    "",
    `Gross sales: ${rupees(statement.grossPaise)}`,
    `Commission: -${rupees(statement.commissionPaise)}`,
    `Gateway fees: -${rupees(statement.gatewayFeePaise)}`,
    `Tax on fees: -${rupees(statement.taxPaise)}`,
    `Refunds: -${rupees(statement.refundPaise)}`,
    `Adjustments: ${rupees(statement.adjustmentPaise)}`,
    `Net settled: ${rupees(statement.netPaise)}`,
    "",
    "Order-level lines",
    ...statement.lines.slice(0, 30).map((line) =>
      `${line.orderNumber || line.settlementId.slice(0, 8)}  gross ${rupees(line.grossPaise)}  net ${rupees(line.netPaise)}`),
    ...(statement.lines.length > 30 ? [`... and ${statement.lines.length - 30} more lines (see CSV).`] : []),
    "",
    `Checksum: ${statement.checksum}`,
  ];
  const stream = `BT\n/F1 10 Tf\n13 TL\n50 795 Td\n${lines.map((line) => `(${escapePdf(line)}) Tj T*`).join("\n")}\nET\n`;
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
