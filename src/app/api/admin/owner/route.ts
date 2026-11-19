import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, users } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";
import { ApiError, BODY_LIMITS, fail, readJson, recordAudit, textValue } from "@/lib/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Outcome =
  | { kind: "success"; business: typeof businesses.$inferSelect; previousOwnerId: string }
  | { kind: "unchanged"; business: typeof businesses.$inferSelect }
  | { kind: "not_found" };

/** Recovery hook for an outlet created under the wrong account. The destination account must already exist. */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request, "admin.reassign_owner", "admin-owner");
    const body = await readJson<{ businessId?: unknown; email?: unknown }>(request, BODY_LIMITS.admin);
    const businessId = textValue(body.businessId, 36);
    const email = textValue(body.email, 254).toLowerCase();
    if (!UUID.test(businessId) || !EMAIL.test(email)) {
      await recordAudit({ request, event: "admin.reassign_owner", outcome: "denied", detail: { reason: "invalid_request" } });
      throw new ApiError("Provide a valid business ID and destination email.");
    }

    const [target] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
    if (!target) {
      await recordAudit({ request, event: "admin.reassign_owner", outcome: "failure", businessId, detail: { reason: "target_not_found" } });
      throw new ApiError("The destination account does not exist. Ask them to register first.", 404);
    }

    const outcome: Outcome = await db.transaction(async (tx) => {
      const [business] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
      if (!business) return { kind: "not_found" } satisfies Outcome;
      if (business.ownerId === target.id) return { kind: "unchanged", business } satisfies Outcome;
      const [updated] = await tx.update(businesses)
        .set({ ownerId: target.id, updatedAt: new Date() })
        .where(eq(businesses.id, businessId))
        .returning();
      return { kind: "success", business: updated, previousOwnerId: business.ownerId } satisfies Outcome;
    });

    if (outcome.kind === "not_found") {
      await recordAudit({ request, event: "admin.reassign_owner", outcome: "failure", businessId, detail: { reason: "business_not_found" } });
      throw new ApiError("Business not found.", 404);
    }
    if (outcome.kind === "unchanged") {
      await recordAudit({ request, event: "admin.reassign_owner", outcome: "success", businessId, detail: { unchanged: true } });
      return NextResponse.json({ business: outcome.business, owner: target });
    }

    await recordAudit({
      request,
      event: "admin.reassign_owner",
      outcome: "success",
      businessId,
      detail: { previousOwnerId: outcome.previousOwnerId, newOwnerId: target.id },
    });
    return NextResponse.json({ business: outcome.business, owner: target });
  } catch (error) { return fail(error, request); }
}
