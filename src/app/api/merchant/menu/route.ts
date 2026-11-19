import { and, asc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { menuItemModifierGroups, menuItems, menuModifierGroups } from "@/db/schema";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteMenu,
  parseRemoteMenuItems,
  parseRemoteMenuModifierGroups,
  parseRemoteOk,
} from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, sameOrigin, textValue } from "@/lib/server";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function values(body: Record<string, unknown>) {
  const name = textValue(body.name, 120), description = textValue(body.description, 500), category = textValue(body.category, 80) || "Other", imageUrl = textValue(body.imageUrl, 1000);
  const price = Number(body.price), dietary = textValue(body.dietary, 20) || "unspecified";
  if (!name || !Number.isSafeInteger(price) || price < 100 || price > 10_000_000) throw new ApiError("Enter an item name and a valid price of at least ₹1.");
  if (!["veg", "nonveg", "unspecified"].includes(dietary)) throw new ApiError("Invalid dietary type.");
  if (imageUrl) { try { if (new URL(imageUrl).protocol !== "https:") throw new Error(); } catch { throw new ApiError("Image must be a valid HTTPS URL."); } }
  const rawStock = body.stockQuantity;
  const stockQuantity = rawStock === undefined || rawStock === null || rawStock === "" ? null : Number(rawStock);
  if (stockQuantity !== null && (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 100_000)) {
    throw new ApiError("Enter a stock quantity between 0 and 100000, or leave it blank for untracked stock.");
  }
  const modifierGroupIds = Array.isArray(body.modifierGroupIds) ? body.modifierGroupIds.map(String) : [];
  if (modifierGroupIds.length > 50 || modifierGroupIds.some((id) => !uuid.test(id))) throw new ApiError("Invalid modifier groups.");
  return { name, description, category, imageUrl, price, dietary, stockQuantity, modifierGroupIds };
}

async function setLocalLinks(businessId: string, itemId: string, groupIds: string[]) {
  const unique = [...new Set(groupIds)];
  if (unique.length) {
    const found = await db.select({ id: menuModifierGroups.id }).from(menuModifierGroups)
      .where(and(eq(menuModifierGroups.businessId, businessId), inArray(menuModifierGroups.id, unique)));
    if (found.length !== unique.length) throw new ApiError("Modifier group not found.", 404);
  }
  await db.delete(menuItemModifierGroups).where(and(
    eq(menuItemModifierGroups.menuItemId, itemId),
    eq(menuItemModifierGroups.businessId, businessId),
  ));
  for (const groupId of unique) {
    await db.insert(menuItemModifierGroups).values({ menuItemId: itemId, modifierGroupId: groupId, businessId });
  }
}

async function localItem(row: typeof menuItems.$inferSelect, links: { menuItemId: string; modifierGroupId: string }[]) {
  return {
    ...row,
    posSynced: false,
    modifierGroupIds: links.filter((link) => link.menuItemId === row.id).map((link) => link.modifierGroupId),
  };
}

export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("menu.read");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/items");
      const payload = parseMarketplaceResponse(remote, (body) => ({
        items: parseRemoteMenuItems(body, business.id),
        modifierGroups: parseRemoteMenuModifierGroups(body),
      }));
      return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
    }
    const [rows, links] = await Promise.all([
      db.select().from(menuItems).where(and(eq(menuItems.businessId, business.id), eq(menuItems.archived, false))).orderBy(asc(menuItems.category), asc(menuItems.name)).limit(500),
      db.select({ menuItemId: menuItemModifierGroups.menuItemId, modifierGroupId: menuItemModifierGroups.modifierGroupId })
        .from(menuItemModifierGroups).where(eq(menuItemModifierGroups.businessId, business.id)),
    ]);
    return NextResponse.json({ items: rows.map((row) => localItem(row, links)), modifierGroups: [] });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("menu.write"); const body = await readJson(request, BODY_LIMITS.menu);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/items", { method: "POST", body: JSON.stringify(body) });
      const item = parseMarketplaceResponse(remote, (payload) => parseRemoteMenu(payload, business.id));
      return NextResponse.json({ item }, { status: 201 });
    }
    const parsed = values(body);
    const [item] = await db.insert(menuItems).values({
      name: parsed.name, description: parsed.description, category: parsed.category, imageUrl: parsed.imageUrl,
      price: parsed.price, dietary: parsed.dietary, stockQuantity: parsed.stockQuantity, businessId: business.id,
    }).returning();
    await setLocalLinks(business.id, item.id, parsed.modifierGroupIds);
    return NextResponse.json({ item: await localItem(item, parsed.modifierGroupIds.map((modifierGroupId) => ({ menuItemId: item.id, modifierGroupId }))) }, { status: 201 });
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const body = await readJson(request, BODY_LIMITS.menu);
    // Availability is the one menu change Servers are allowed to make; editing or
    // archiving an item still requires full menu access.
    const { business } = await requireBusiness(body.action === "availability" ? "menu.availability" : "menu.write");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/items", { method: "PATCH", body: JSON.stringify(body) });
      const item = parseMarketplaceResponse(remote, (payload) => parseRemoteMenu(payload, business.id));
      return NextResponse.json({ item });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id)) throw new ApiError("Invalid item.");
    const scope = and(eq(menuItems.id, body.id), eq(menuItems.businessId, business.id), eq(menuItems.archived, false));
    const [existing] = await db.select().from(menuItems).where(scope).limit(1);
    if (!existing) throw new ApiError("Item not found.", 404);
    if (body.action === "modifier-groups") {
      if (!Array.isArray(body.modifierGroupIds)) throw new ApiError("Invalid modifier groups.");
      const ids = body.modifierGroupIds.map(String);
      if (ids.length > 50 || ids.some((id) => !uuid.test(id))) throw new ApiError("Invalid modifier groups.");
      await setLocalLinks(business.id, body.id, ids);
      return NextResponse.json({ item: await localItem(existing, ids.map((modifierGroupId) => ({ menuItemId: existing.id, modifierGroupId }))) });
    }
    const changes = body.action === "availability"
      ? (typeof body.available === "boolean" ? { available: body.available } : null)
      : (() => { const parsed = values(body); return {
          name: parsed.name, description: parsed.description, category: parsed.category,
          imageUrl: parsed.imageUrl, price: parsed.price, dietary: parsed.dietary, stockQuantity: parsed.stockQuantity,
        }; })();
    if (!changes) throw new ApiError("Invalid availability.");
    const [item] = await db.update(menuItems).set({ ...changes, updatedAt: new Date() }).where(scope).returning();
    if (!item) throw new ApiError("This item changed on another device. Refresh and try again.", 409);
    const parsed = body.action === "availability" ? null : values(body);
    if (parsed) await setLocalLinks(business.id, item.id, parsed.modifierGroupIds);
    const links = await db.select({ menuItemId: menuItemModifierGroups.menuItemId, modifierGroupId: menuItemModifierGroups.modifierGroupId })
      .from(menuItemModifierGroups).where(eq(menuItemModifierGroups.menuItemId, item.id));
    return NextResponse.json({ item: await localItem(item, links) });
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("menu.write"); const body = await readJson(request, BODY_LIMITS.menu);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/items", { method: "DELETE", body: JSON.stringify(body) });
      parseMarketplaceResponse(remote, parseRemoteOk);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.id !== "string" || !uuid.test(body.id)) throw new ApiError("Invalid item.");
    const [item] = await db.update(menuItems).set({ archived: true, available: false, updatedAt: new Date() }).where(and(eq(menuItems.id, body.id), eq(menuItems.businessId, business.id), eq(menuItems.archived, false))).returning();
    if (!item) throw new ApiError("Item not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error, request); }
}
