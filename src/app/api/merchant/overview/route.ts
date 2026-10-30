import { and, desc, eq, gte, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { orders, settlements } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch } from "@/lib/marketplace-bridge";
import { fail, requireBusiness } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { business } = await requireBusiness();
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch<any>(business.id, "/api/integration/merchant/overview");
      const restaurant = remote.restaurant ?? {};
      const mappedBusiness = {
        ...business,
        name: restaurant.name || business.name,
        isOpen: Boolean(restaurant.isActive),
        hoursEnabled: Boolean(restaurant.merchantHoursEnabled),
        opensAt: restaurant.merchantOpensAt || business.opensAt,
        closesAt: restaurant.merchantClosesAt || business.closesAt,
        pickupEnabled: restaurant.merchantPickupEnabled ?? business.pickupEnabled,
        deliveryEnabled: restaurant.merchantDeliveryEnabled ?? business.deliveryEnabled,
      };
      const overview = remote.overview ?? {};
      return NextResponse.json({ business: mappedBusiness, overview: {
        counts: overview.counts ?? { new: 0, accepted: 0, preparing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 },
        todaySales: Number(overview.todaySales ?? 0), todayOrders: Number(overview.todayOrders ?? 0),
        completedToday: Number(overview.completedToday ?? 0), latestNewOrderId: overview.latestNewOrderId ?? null,
        settlements: overview.settlements ?? [],
      } }, { headers: { "Cache-Control": "no-store" } });
    }
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const start = new Date(`${date}T00:00:00+05:30`);
    const [groups, [today], [completed], settlementRows, [latestNew]] = await Promise.all([
      db.select({ status: orders.status, count: sql<number>`count(*)::int` }).from(orders).where(eq(orders.businessId, business.id)).groupBy(orders.status),
      db.select({ count: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.businessId, business.id), gte(orders.createdAt, start))),
      db.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${orders.total}), 0)`.mapWith(Number) }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "completed"), gte(orders.updatedAt, start))),
      db.select().from(settlements).where(eq(settlements.businessId, business.id)).orderBy(desc(settlements.createdAt)).limit(20),
      db.select({ id: orders.id }).from(orders).where(and(eq(orders.businessId, business.id), eq(orders.status, "new"))).orderBy(desc(orders.createdAt)).limit(1),
    ]);
    const counts: Record<string, number> = { new: 0, accepted: 0, preparing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    groups.forEach((group) => { if (group.status in counts) counts[group.status] = group.count; });
    return NextResponse.json({ business, overview: { counts, todaySales: completed.total, todayOrders: today.count, completedToday: completed.count, latestNewOrderId: latestNew?.id ?? null, settlements: settlementRows } });
  } catch (error) { return fail(error); }
}
