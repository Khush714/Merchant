import { NextRequest, NextResponse } from "next/server";
import { listingFor } from "@/lib/workspace-bootstrap";
import { ApiError, BODY_LIMITS, businessesForUser, fail, readJson, requireUser, sameOrigin, sessionContext, setActiveBusinessForSession, textValue, verificationRequired } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Outlets available to this account plus the one selected for this browser session. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const context = await sessionContext();
    const payload = await listingFor(user.id, context?.activeBusinessId);
    return NextResponse.json({ activeBusinessId: payload.business?.id ?? null, user, ...payload, verificationRequired: verificationRequired() });
  } catch (error) { return fail(error, request); }
}

/** Switch the active outlet for this browser only. Membership is rechecked server-side. */
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const user = await requireUser();
    const body = await readJson(request, BODY_LIMITS.admin);
    const businessId = textValue(body.businessId, 36);
    if (!UUID.test(businessId)) throw new ApiError("Choose a valid outlet.");
    const allowed = await businessesForUser(user.id);
    if (!allowed.some((entry) => entry.business.id === businessId)) {
      throw new ApiError("You don't have access to that outlet.", 403);
    }
    await setActiveBusinessForSession(businessId);
    return NextResponse.json({ activeBusinessId: businessId, user, ...(await listingFor(user.id, businessId)), verificationRequired: verificationRequired() });
  } catch (error) { return fail(error, request); }
}
