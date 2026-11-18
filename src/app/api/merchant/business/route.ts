import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { applyRemoteRestaurant, parseRemoteRestaurantResponse } from "@/lib/marketplace-payload";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse } from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, requireUser, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try { const { business } = await requireBusiness("overview.read"); return NextResponse.json({ business }); }
  catch (error) { return fail(error, request); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    const user = await requireUser();
    const body = await readJson(request, BODY_LIMITS.business);
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
  } catch (error) { return fail(error, request); }
}
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request);
    const { business } = await requireBusiness("settings.write");
    const body = await readJson(request, BODY_LIMITS.business);
    const linked = Boolean(await getMarketplaceLink(business.id));
    if (body.action === "availability") {
      if (typeof body.isOpen !== "boolean") throw new ApiError("Invalid availability.");
      if (body.isOpen && business.approvalStatus !== "approved" && !linked) throw new ApiError("Your listing must be approved before it can accept orders.", 403);
      const remoteRestaurant = linked
        ? parseMarketplaceResponse(
            await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ isActive: body.isOpen }) }),
            parseRemoteRestaurantResponse,
          )
        : null;
      const [updated] = await db.update(businesses).set({ isOpen: body.isOpen, updatedAt: new Date() }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: remoteRestaurant ? applyRemoteRestaurant(updated, remoteRestaurant) : updated });
    }
    if (body.action === "details") {
      const name = textValue(body.name, 100), ownerName = textValue(body.ownerName, 100), phone = textValue(body.phone, 30), address = textValue(body.address, 300);
      if (body.submit && (!name || !ownerName || !phone || !address)) throw new ApiError("Please complete the business name, owner, phone and address.");
      const remoteRestaurant = linked
        ? parseMarketplaceResponse(
            await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ name }) }),
            parseRemoteRestaurantResponse,
          )
        : null;
      const [updated] = await db.update(businesses).set({
        name, ownerName, phone, address, category: textValue(body.category, 100), registrationDetails: textValue(body.registrationDetails, 200),
        approvalStatus: body.submit && business.approvalStatus === "draft" ? "pending" : business.approvalStatus,
        updatedAt: new Date(),
      }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: remoteRestaurant ? applyRemoteRestaurant(updated, remoteRestaurant) : updated });
    }
    if (body.action === "settings") {
      if (typeof body.pickupEnabled !== "boolean" || typeof body.deliveryEnabled !== "boolean" || typeof body.hoursEnabled !== "boolean") throw new ApiError("Invalid settings.");
      if (!body.pickupEnabled && !body.deliveryEnabled) throw new ApiError("Enable at least one fulfilment option.");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.opensAt) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.closesAt) || body.opensAt === body.closesAt) throw new ApiError("Enter valid opening and closing times.");
      const remoteRestaurant = linked
        ? parseMarketplaceResponse(
            await marketplaceFetch(business.id, "/api/integration/merchant/business", { method: "PATCH", body: JSON.stringify({ merchantPickupEnabled: body.pickupEnabled, merchantDeliveryEnabled: body.deliveryEnabled, merchantHoursEnabled: body.hoursEnabled, merchantOpensAt: body.opensAt, merchantClosesAt: body.closesAt }) }),
            parseRemoteRestaurantResponse,
          )
        : null;
      const [updated] = await db.update(businesses).set({ pickupEnabled: body.pickupEnabled, deliveryEnabled: body.deliveryEnabled, hoursEnabled: body.hoursEnabled, opensAt: body.opensAt, closesAt: body.closesAt, updatedAt: new Date() }).where(eq(businesses.id, business.id)).returning();
      return NextResponse.json({ business: remoteRestaurant ? applyRemoteRestaurant(updated, remoteRestaurant) : updated });
    }
    throw new ApiError("Unknown action.");
  } catch (error) { return fail(error, request); }
}
