import { and, asc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { menuItemModifierGroups, menuModifierGroups, menuModifierOptions } from "@/db/schema";
import {
  getMarketplaceLink,
  marketplaceFetch,
  parseMarketplaceResponse,
  parseRemoteMenuModifierGroupResponse,
  parseRemoteMenuModifierGroups,
} from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, fail, readJson, requireBusiness, sameOrigin, textValue } from "@/lib/server";
import type { MenuModifierGroup } from "@/lib/types";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function groupValues(body: Record<string, unknown>) {
  const name = textValue(body.name, 60);
  if (!name) throw new ApiError("Enter a group name.");
  const minSelect = Number(body.minSelect ?? 0), maxSelect = Number(body.maxSelect ?? 1);
  if (!Number.isSafeInteger(minSelect) || minSelect < 0 || minSelect > 20) throw new ApiError("Minimum selections must be between 0 and 20.");
  if (!Number.isSafeInteger(maxSelect) || maxSelect < 1 || maxSelect > 20 || maxSelect < minSelect) {
    throw new ApiError("Maximum selections must be between the minimum and 20.");
  }
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  if (!rawOptions.length || rawOptions.length > 30) throw new ApiError("Add between 1 and 30 options.");
  const options = rawOptions.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("Invalid modifier option.");
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" && uuid.test(row.id) ? row.id : undefined;
    const optionName = textValue(row.name, 60);
    const priceCents = Number(row.priceCents ?? 0);
    if (!optionName || !Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 1_000_000) {
      throw new ApiError("Enter an option name and a valid price.");
    }
    return { id, name: optionName, priceCents, isVeg: row.isVeg === undefined ? true : Boolean(row.isVeg), available: row.available === undefined ? true : Boolean(row.available) };
  });
  return { name, minSelect, maxSelect, isActive: body.isActive === undefined ? true : Boolean(body.isActive), options };
}

async function localGroups(businessId: string): Promise<MenuModifierGroup[]> {
  const [groups, options, links] = await Promise.all([
    db.select().from(menuModifierGroups).where(eq(menuModifierGroups.businessId, businessId)).orderBy(asc(menuModifierGroups.name), asc(menuModifierGroups.id)),
    db.select().from(menuModifierOptions).where(eq(menuModifierOptions.businessId, businessId)).orderBy(asc(menuModifierOptions.name), asc(menuModifierOptions.id)),
    db.select({ groupId: menuItemModifierGroups.modifierGroupId }).from(menuItemModifierGroups).where(eq(menuItemModifierGroups.businessId, businessId)),
  ]);
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    isActive: group.isActive,
    posSynced: false,
    itemCount: links.filter((link) => link.groupId === group.id).length,
    options: options.filter((option) => option.groupId === group.id).map((option) => ({
      id: option.id, name: option.name, priceCents: option.priceCents,
      isVeg: option.isVeg, available: option.available, posSynced: false,
    })),
  }));
}

async function localGroup(businessId: string, id: string): Promise<MenuModifierGroup> {
  const group = (await localGroups(businessId)).find((row) => row.id === id);
  if (!group) throw new ApiError("Modifier group not found.", 404);
  return group;
}

function groupId(value: unknown): string {
  const id = typeof value === "string" ? value : String(value ?? "");
  if (!uuid.test(id)) throw new ApiError("Invalid modifier group.");
  return id;
}

export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("menu.read");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/modifier-groups");
      const modifierGroups = parseMarketplaceResponse(remote, parseRemoteMenuModifierGroups);
      return NextResponse.json({ modifierGroups }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ modifierGroups: await localGroups(business.id) });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("menu.write"); const body = await readJson(request, BODY_LIMITS.menu);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/modifier-groups", { method: "POST", body: JSON.stringify(body) });
      const group = parseMarketplaceResponse(remote, parseRemoteMenuModifierGroupResponse);
      return NextResponse.json({ group }, { status: 201 });
    }
    const parsed = groupValues(body);
    const id = await db.transaction(async (tx) => {
      const [group] = await tx.insert(menuModifierGroups).values({
        businessId: business.id, name: parsed.name, minSelect: parsed.minSelect,
        maxSelect: parsed.maxSelect, isActive: parsed.isActive,
      }).returning({ id: menuModifierGroups.id });
      for (const option of parsed.options) {
        await tx.insert(menuModifierOptions).values({
          groupId: group.id, businessId: business.id, name: option.name,
          priceCents: option.priceCents, isVeg: option.isVeg, available: option.available,
        });
      }
      return group.id;
    });
    return NextResponse.json({ group: await localGroup(business.id, id) }, { status: 201 });
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request); const body = await readJson(request, BODY_LIMITS.menu); const { business } = await requireBusiness("menu.write");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/modifier-groups", { method: "PATCH", body: JSON.stringify(body) });
      const group = parseMarketplaceResponse(remote, parseRemoteMenuModifierGroupResponse);
      return NextResponse.json({ group });
    }
    const id = groupId(body.id);
    const current = await localGroup(business.id, id);
    if (current.posSynced) throw new ApiError("This group is managed by the connected POS.", 409);
    const parsed = groupValues(body);
    await db.transaction(async (tx) => {
      await tx.update(menuModifierGroups).set({ name: parsed.name, minSelect: parsed.minSelect, maxSelect: parsed.maxSelect, isActive: parsed.isActive, updatedAt: new Date() })
        .where(and(eq(menuModifierGroups.id, id), eq(menuModifierGroups.businessId, business.id)));
      const existing = await tx.select({ id: menuModifierOptions.id }).from(menuModifierOptions).where(eq(menuModifierOptions.groupId, id));
      const existingIds = new Set(existing.map((row) => row.id));
      const keepIds = parsed.options.map((option) => option.id).filter((value): value is string => Boolean(value && existingIds.has(value)));
      const dropIds = [...existingIds].filter((value) => !keepIds.includes(value));
      if (dropIds.length) await tx.delete(menuModifierOptions).where(and(eq(menuModifierOptions.groupId, id), inArray(menuModifierOptions.id, dropIds)));
      for (const option of parsed.options) {
        if (option.id && keepIds.includes(option.id)) {
          await tx.update(menuModifierOptions).set({ name: option.name, priceCents: option.priceCents, isVeg: option.isVeg, available: option.available })
            .where(and(eq(menuModifierOptions.id, option.id), eq(menuModifierOptions.groupId, id)));
        } else {
          await tx.insert(menuModifierOptions).values({
            groupId: id, businessId: business.id, name: option.name,
            priceCents: option.priceCents, isVeg: option.isVeg, available: option.available,
          });
        }
      }
    });
    return NextResponse.json({ group: await localGroup(business.id, id) });
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: NextRequest) {
  try {
    sameOrigin(request); const { business } = await requireBusiness("menu.write"); const body = await readJson(request, BODY_LIMITS.menu);
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/menu/modifier-groups", { method: "DELETE", body: JSON.stringify(body) });
      parseMarketplaceResponse(remote, (payload) => payload);
      return NextResponse.json({ ok: true });
    }
    const id = groupId(body.id);
    const current = await localGroup(business.id, id);
    if (current.posSynced) throw new ApiError("This group is managed by the connected POS.", 409);
    await db.delete(menuModifierGroups).where(and(eq(menuModifierGroups.id, id), eq(menuModifierGroups.businessId, business.id)));
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error, request); }
}
