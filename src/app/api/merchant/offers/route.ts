import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { offers, orders } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db-errors";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { offerDto, parseOfferInput } from "@/lib/offers";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, sameOrigin, textValue } from "@/lib/server";
import type { OfferInput } from "@/lib/types";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inputFrom(body: Record<string, unknown>) {
  try { return parseOfferInput(body); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : "Please check the offer details."); }
}
function offerIdFrom(body: Record<string, unknown>) {
  const id = textValue(body.id, 50);
  if (!uuid.test(id)) throw new ApiError("Offer not found.", 404);
  return id;
}
function toStored(input: OfferInput) {
  return {
    ...input,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
  };
}

/** Merchant promotion library. Paired listings are proxied so Marketplace stays authoritative. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("offers.read");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/offers");
      return NextResponse.json({ offers: remote.offers ?? [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const rows = await db.select({
      offer: offers,
      redemptions: sql<number>`count(${orders.id})::int`,
      discountGiven: sql<number>`coalesce(sum(${orders.discount}), 0)::int`.mapWith(Number),
      influencedGross: sql<number>`coalesce(sum(${orders.total}), 0)::int`.mapWith(Number),
    }).from(offers)
      .leftJoin(orders, eq(orders.offerId, offers.id))
      .where(eq(offers.businessId, business.id))
      .groupBy(offers.id)
      .orderBy(desc(offers.createdAt)).limit(500);
    return NextResponse.json({
      offers: rows.map((row) => offerDto(row.offer, {
        redemptions: row.redemptions, discountGiven: row.discountGiven, influencedGross: row.influencedGross,
      })),
    });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("offers.write"); const body = await readJson(request, BODY_LIMITS.offers);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/offers", { method: "POST", body: JSON.stringify(body) });
      return NextResponse.json({ offer: remote.offer }, { status: 201 });
    }
    const input = inputFrom(body);
    try {
      const [offer] = await db.insert(offers).values({ ...toStored(input), businessId: business.id }).returning();
      return NextResponse.json({ offer: offerDto(offer) }, { status: 201 });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError("That code is already in use. Choose another one.", 409);
      throw error;
    }
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("offers.write"); const body = await readJson(request, BODY_LIMITS.offers);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/offers", { method: "PATCH", body: JSON.stringify(body) });
      return NextResponse.json({ offer: remote.offer });
    }
    const id = offerIdFrom(body);
    const [existing] = await db.select().from(offers).where(and(eq(offers.id, id), eq(offers.businessId, business.id), eq(offers.archived, false))).limit(1);
    if (!existing) throw new ApiError("Offer not found.", 404);
    let changes: Partial<typeof offers.$inferInsert> = { updatedAt: new Date() };
    if (body.action === "toggle") changes.active = !existing.active;
    else if (body.action !== undefined) throw new ApiError("Invalid offer action.");
    else changes = { ...toStored(inputFrom(body)), updatedAt: new Date() };
    try {
      const [offer] = await db.update(offers).set(changes).where(and(eq(offers.id, id), eq(offers.businessId, business.id))).returning();
      if (!offer) throw new ApiError("This offer changed on another device. Refresh and try again.", 409);
      return NextResponse.json({ offer: offerDto(offer) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError("That code is already in use. Choose another one.", 409);
      throw error;
    }
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("offers.write"); const body = await readJson(request, BODY_LIMITS.offers);
    if (await getMarketplaceLink(business.id)) {
      await marketplaceFetch<any>(business.id, "/api/integration/merchant/offers", { method: "DELETE", body: JSON.stringify(body) });
      return NextResponse.json({ ok: true });
    }
    const id = offerIdFrom(body);
    const [offer] = await db.update(offers).set({ archived: true, active: false, updatedAt: new Date() })
      .where(and(eq(offers.id, id), eq(offers.businessId, business.id), eq(offers.archived, false))).returning();
    if (!offer) throw new ApiError("Offer not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error, request); }
}
