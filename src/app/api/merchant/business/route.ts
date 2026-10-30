import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError, fail, requireBusiness, requireUser, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try { const { business } = await requireBusiness(); return NextResponse.json({ business }); }
  catch (error) { return fail(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const user = await requireUser();
    const body = await request.json();
    if (body.type !== "restaurant" && body.type !== "vendor") throw new ApiError("Choose a business type.");
    const [existing] = await db.select().from(businesses).where(eq(businesses.ownerId, user.id)).limit(1);
    if (existing) {
      if (existing.approvalStatus !== "draft") return NextResponse.json({ business: existing });
      const [business] = await db.update(businesses).set({ type: body.type, updatedAt: new Date() }).where(eq(businesses.id, existing.id)).returning();
      return NextResponse.json({ business });
    }
    const [business] = await db.insert(businesses).values({ ownerId: user.id, type: body.type }).onConflictDoNothing().returning();
    if (!business) throw new ApiError("Business already exists. Refresh and try again.", 409);
    return NextResponse.json({ business }, { status: 201 });
  } catch (error) { return fail(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request);
    const { business } = await requireBusiness();
    const body = await request.json();
    if (body.action === "availability") {
      if (typeof body.isOpen !== "boolean") throw new ApiError("Invalid availability.");
      if (body.isOpen && business.approvalStatus !== "approved") throw new ApiError("Your listing must be approved before it can accept orders.", 403);
      if (await getMarketplaceLink(business.id)) await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ isActive: body.isOpen }) });
      const [updated] = await db.update(businesses).set({ isOpen: body.isOpen, updatedAt: new Date() }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: updated });
    }
    if (body.action === "details") {
      const name = textValue(body.name, 100), ownerName = textValue(body.ownerName, 100), phone = textValue(body.phone, 30), address = textValue(body.address, 300);
      if (body.submit && (!name || !ownerName || !phone || !address)) throw new ApiError("Please complete the business name, owner, phone and address.");
      if (await getMarketplaceLink(business.id)) await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ name }) });
      const [updated] = await db.update(businesses).set({
        name, ownerName, phone, address, category: textValue(body.category, 100), registrationDetails: textValue(body.registrationDetails, 200),
        approvalStatus: body.submit && business.approvalStatus === "draft" ? "pending" : business.approvalStatus,
        updatedAt: new Date(),
      }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: updated });
    }
    if (body.action === "settings") {
      if (typeof body.pickupEnabled !== "boolean" || typeof body.deliveryEnabled !== "boolean" || typeof body.hoursEnabled !== "boolean") throw new ApiError("Invalid settings.");
      if (!body.pickupEnabled && !body.deliveryEnabled) throw new ApiError("Enable at least one fulfilment option.");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.opensAt) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.closesAt) || body.opensAt === body.closesAt) throw new ApiError("Enter valid opening and closing times.");
      if (await getMarketplaceLink(business.id)) await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ merchantPickupEnabled: body.pickupEnabled, merchantDeliveryEnabled: body.deliveryEnabled, merchantHoursEnabled: body.hoursEnabled, merchantOpensAt: body.opensAt, merchantClosesAt: body.closesAt }) });
      const [updated] = await db.update(businesses).set({ pickupEnabled: body.pickupEnabled, deliveryEnabled: body.deliveryEnabled, hoursEnabled: body.hoursEnabled, opensAt: body.opensAt, closesAt: body.closesAt, updatedAt: new Date() }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: updated });
    }
    throw new ApiError("Unknown action.");
  } catch (error) { return fail(error); }
}
