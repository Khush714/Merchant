import { eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { getMarketplaceLink, marketplaceFetch, parseMarketplaceResponse, parseRemoteSyncVersion } from "@/lib/marketplace-bridge";
import { fail, requireBusiness } from "@/lib/server";
import { workspaceSyncVersion, type WorkspaceSyncSnapshot } from "@/lib/sync-version";

export const dynamic = "force-dynamic";

/**
 * Cheap signal for the browser refresh loop. Paired businesses read the version
 * computed by Marketplace from its authoritative order table; unpaired ones use
 * the equivalent local aggregates. No order payload crosses this route.
 */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("orders.read");
    if (await getMarketplaceLink(business.id)) {
      const remote = await marketplaceFetch(business.id, "/api/integration/merchant/changes");
      const parsed = parseMarketplaceResponse(remote, parseRemoteSyncVersion);
      return NextResponse.json(parsed, { headers: { "Cache-Control": "no-store" } });
    }
    const [row] = await db.select({
      count: sql<number>`count(*)::int`,
      paidCount: sql<number>`count(*) filter (where ${orders.paymentStatus} = 'paid')::int`,
      latestCreated: sql<string | null>`max(${orders.createdAt})::text`,
      latestStatus: sql<string | null>`max(${orders.updatedAt})::text`,
      latestEvent: sql<string | null>`max(${orders.updatedAt})::text`,
      latestFeedback: sql<string | null>`max(${orders.feedbackAt})::text`,
      latestReply: sql<string | null>`max(${orders.merchantRespondedAt})::text`,
    }).from(orders).where(eq(orders.businessId, business.id));
    const snapshot: WorkspaceSyncSnapshot = {
      count: Number(row?.count ?? 0),
      paidCount: Number(row?.paidCount ?? 0),
      latestCreated: row?.latestCreated ?? null,
      latestStatus: row?.latestStatus ?? null,
      latestEvent: row?.latestEvent ?? null,
      latestFeedback: row?.latestFeedback ?? null,
      latestReply: row?.latestReply ?? null,
    };
    return NextResponse.json(
      { ok: true, ...workspaceSyncVersion(snapshot) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) { return fail(error, request); }
}
