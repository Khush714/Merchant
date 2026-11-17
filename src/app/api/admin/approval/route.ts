import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";
import { ApiError, BODY_LIMITS, fail, readJson, recordAudit } from "@/lib/server";

// Service-to-service approval hook. Never expose the token to a browser.
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request, "admin.approval", "approval");
    const body = await readJson(request, BODY_LIMITS.admin);
    if (typeof body.businessId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.businessId) || !["approved", "rejected"].includes(body.status)) {
      await recordAudit({ request, event: "admin.approval", outcome: "denied", detail: { reason: "invalid_request" } });
      throw new ApiError("Invalid approval request.");
    }
    const [business] = await db.update(businesses).set({ approvalStatus: body.status, isOpen: false, updatedAt: new Date() }).where(and(eq(businesses.id, body.businessId), eq(businesses.approvalStatus, "pending"))).returning({ id: businesses.id, approvalStatus: businesses.approvalStatus });
    if (!business) {
      await recordAudit({ request, event: "admin.approval", outcome: "failure", businessId: body.businessId, detail: { reason: "not_pending", status: body.status } });
      throw new ApiError("Pending business not found.", 404);
    }
    await recordAudit({ request, event: "admin.approval", outcome: "success", businessId: business.id, detail: { status: business.approvalStatus } });
    return NextResponse.json({ business });
  } catch (error) { return fail(error, request); }
}
