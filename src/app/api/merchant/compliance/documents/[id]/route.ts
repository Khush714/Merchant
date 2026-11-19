import { NextRequest, NextResponse } from "next/server";
import { complianceFail } from "@/lib/compliance-api";
import { deleteComplianceDocument, findComplianceDocument } from "@/lib/compliance-data";
import { decryptDocument, deleteDocumentObject, downloadDocumentObject } from "@/lib/document-storage";
import { ApiError, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function attachmentName(fileName: string) {
  const safe = fileName.replace(/[\r\n"\\]/g, "_").slice(0, 160) || "document";
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

/** The browser only ever receives decrypted bytes from this authenticated proxy. */
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { business } = await requireBusiness("compliance.read");
    const { id } = await params;
    const document = await findComplianceDocument(business.id, id);
    if (!document) throw new ApiError("Document not found.", 404);
    const encrypted = await downloadDocumentObject(document.storageKey);
    // Storage holds the v1 envelope text; decryptDocument returns the original file bytes.
    const bytes = decryptDocument(encrypted.toString("utf8"));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": document.contentType,
        "Content-Disposition": attachmentName(document.fileName),
        "Content-Length": String(document.byteSize),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return complianceFail(error, request); }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-document-delete", 12);
    const { business, user } = await requireBusiness("compliance.write");
    const { id } = await params;
    const document = await findComplianceDocument(business.id, id);
    if (!document) throw new ApiError("Document not found.", 404);
    await deleteDocumentObject(document.storageKey);
    await deleteComplianceDocument(business.id, id);
    await recordAudit({
      request, event: "compliance.document_delete", outcome: "success", userId: user.id, businessId: business.id,
      detail: { kind: document.kind },
    });
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}
