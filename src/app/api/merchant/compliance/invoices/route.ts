import { NextRequest, NextResponse } from "next/server";
import { complianceFail, readOptionalJson } from "@/lib/compliance-api";
import { createProFormaInvoice, listInvoices, syncMarketplaceInvoices } from "@/lib/compliance-data";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

function boundedInt(value: string | null, fallback: number, max: number, label: string) {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new ApiError(`${label} is out of range.`, 400);
  return parsed;
}

/** Paired outlets see Marketplace mirrors; unpaired outlets see clearly labelled pro forma documents. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const params = request.nextUrl.searchParams;
    const sourceValue = params.get("source");
    if (sourceValue && sourceValue !== "marketplace" && sourceValue !== "proforma") throw new ApiError("Choose a valid invoice source.", 400);
    const result = await listInvoices(business.id, {
      limit: Math.max(1, boundedInt(params.get("limit"), 50, 100, "Limit")),
      offset: boundedInt(params.get("offset"), 0, 10_000, "Offset"),
      source: sourceValue as "marketplace" | "proforma" | undefined,
    });
    const link = await getMarketplaceLink(business.id);
    return NextResponse.json({ ...result, paired: Boolean(link) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-invoices", 12);
    const { business, user } = await requireBusiness("compliance.write");
    const input = await readOptionalJson<Record<string, unknown>>(request, BODY_LIMITS.compliance);
    const action = input.action ?? "sync";
    if (action === "sync") {
      const result = await syncMarketplaceInvoices(business.id, { from: input.from, to: input.to });
      await recordAudit({
        request, event: "compliance.invoice_sync", outcome: "success", userId: user.id, businessId: business.id,
        detail: { available: result.available, received: result.received, applied: result.applied, skipped: result.skipped },
      });
      return NextResponse.json({ sync: result }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "proforma") {
      const invoice = await createProFormaInvoice(business.id, input.orderId);
      await recordAudit({
        request, event: "compliance.invoice_proforma", outcome: "success", userId: user.id, businessId: business.id,
        detail: { invoiceNumber: invoice.invoiceNumber, orderId: invoice.orderId },
      });
      return NextResponse.json({ invoice }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }
    throw new ApiError("Choose sync or proforma as the invoice action.", 400);
  } catch (error) { return complianceFail(error, request); }
}
