import { NextRequest, NextResponse } from "next/server";
import { complianceFail } from "@/lib/compliance-api";
import { insertComplianceDocument, listComplianceDocuments } from "@/lib/compliance-data";
import { validateDocumentFile } from "@/lib/compliance-validation";
import {
  deleteDocumentObject, documentStorageConfigured, encryptDocument, newStorageKey, uploadDocumentObject,
} from "@/lib/document-storage";
import { ApiError, BODY_LIMITS, rateLimit, recordAudit, requireBusiness, sameOrigin } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("compliance.read");
    return NextResponse.json({ documents: await listComplianceDocuments(business.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}

/** Owner-only upload. Bytes are encrypted before they reach the private Supabase bucket. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "compliance-document-upload", 8);
    const { business, user } = await requireBusiness("compliance.write");
    if (!documentStorageConfigured()) throw new ApiError("Private document storage is not configured.", 503);
    const declared = Number(request.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > BODY_LIMITS.complianceDocument + 64 * 1024) {
      throw new ApiError("Request body is too large.", 413);
    }
    let form: FormData;
    try { form = await request.formData(); } catch { throw new ApiError("Send the document as multipart form data.", 400); }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("Choose a document to upload.", 400);
    const kind = form.get("kind");
    const expiry = form.get("expiresAt");
    const bytes = Buffer.from(await file.arrayBuffer());
    const checked = validateDocumentFile({
      kind,
      contentType: file.type,
      bytes,
      expiresAt: typeof expiry === "string" ? expiry : undefined,
    });
    const fileName = file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "document";
    const storageKey = newStorageKey(business.id, checked.kind, fileName);
    await uploadDocumentObject(storageKey, Buffer.from(encryptDocument(bytes), "utf8"));
    let document;
    try {
      document = await insertComplianceDocument({
        businessId: business.id,
        kind: checked.kind,
        fileName,
        contentType: checked.contentType,
        byteSize: checked.byteSize,
        sha256: checked.sha256,
        storageKey,
        expiresAt: checked.expiresAt,
        uploadedBy: user.id,
      });
    } catch (error) {
      await deleteDocumentObject(storageKey).catch(() => {});
      throw error;
    }
    await recordAudit({
      request, event: "compliance.document_upload", outcome: "success", userId: user.id, businessId: business.id,
      detail: { kind: checked.kind, byteSize: checked.byteSize, sha256: checked.sha256 },
    });
    return NextResponse.json({ document }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return complianceFail(error, request); }
}
