import { and, asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { menuItems } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { ApiError, fail, requireBusiness, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function values(body: Record<string, unknown>) {
  const name = textValue(body.name, 120), description = textValue(body.description, 500), category = textValue(body.category, 80) || "Other", imageUrl = textValue(body.imageUrl, 1000);
  const price = Number(body.price), dietary = textValue(body.dietary, 20) || "unspecified";
  if (!name || !Number.isSafeInteger(price) || price < 100 || price > 10_000_000) throw new ApiError("Enter an item name and a valid price of at least ₹1.");
  if (!["veg", "nonveg", "unspecified"].includes(dietary)) throw new ApiError("Invalid dietary type.");
  if (imageUrl) { try { if (new URL(imageUrl).protocol !== "https:") throw new Error(); } catch { throw new ApiError("Image must be a valid HTTPS URL."); } }
  return { name, description, category, imageUrl, price, dietary };
}
export async function GET() {
  try {
    const { business } = await requireBusiness();
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/menu/items");
      return NextResponse.json({ items: remote.items ?? [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const items = await db.select().from(menuItems).where(and(eq(menuItems.businessId, business.id), eq(menuItems.archived, false))).orderBy(asc(menuItems.category), asc(menuItems.name)).limit(500);
    return NextResponse.json({ items });
  } catch (error) { return fail(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness(); const body = await request.json();
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/menu/items", { method: "POST", body: JSON.stringify(body) });
      return NextResponse.json({ item: remote.item }, { status: 201 });
    }
    const [item] = await db.insert(menuItems).values({ ...values(body), businessId: business.id }).returning();
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) { return fail(error); }
}
export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness(); const body = await request.json();
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/menu/items", { method: "PATCH", body: JSON.stringify(body) });
      return NextResponse.json({ item: remote.item });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id)) throw new ApiError("Invalid item.");
    const scope = and(eq(menuItems.id, body.id), eq(menuItems.businessId, business.id), eq(menuItems.archived, false));
    const [existing] = await db.select().from(menuItems).where(scope).limit(1);
    if (!existing) throw new ApiError("Item not found.", 404);
    const changes = body.action === "availability" ? (typeof body.available === "boolean" ? { available: body.available } : null) : values(body);
    if (!changes) throw new ApiError("Invalid availability.");
    const [item] = await db.update(menuItems).set({ ...changes, updatedAt: new Date() }).where(scope).returning();
    if (!item) throw new ApiError("This item changed on another device. Refresh and try again.", 409);
    return NextResponse.json({ item });
  } catch (error) { return fail(error); }
}
export async function DELETE(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness(); const body = await request.json();
    if (await getMarketplaceLink(business.id)) {
      await marketplaceFetch<any>(business.id, "/api/integration/merchant/menu/items", { method: "DELETE", body: JSON.stringify(body) });
      return NextResponse.json({ ok: true });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id)) throw new ApiError("Invalid item.");
    const [item] = await db.update(menuItems).set({ archived: true, available: false, updatedAt: new Date() }).where(and(eq(menuItems.id, body.id), eq(menuItems.businessId, business.id), eq(menuItems.archived, false))).returning();
    if (!item) throw new ApiError("Item not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error); }
}
