import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { staffMembers, users } from "@/db/schema";
import { isStaffRole } from "@/lib/roles";
import { ApiError, BODY_LIMITS, fail, rateLimit, readJson, recordAudit, requireBusiness, sameOrigin, textValue } from "@/lib/server";
import type { StaffMember } from "@/lib/types";

export const dynamic = "force-dynamic";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function dto(row: typeof staffMembers.$inferSelect, email: string): StaffMember {
  return {
    id: row.id, businessId: row.businessId, userId: row.userId, email,
    role: isStaffRole(row.role) ? row.role : "server",
    status: row.status === "removed" ? "removed" : "active",
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** Staff access belongs to the outlet owner. Every operation is audited and never proxied. */
export async function GET(request: NextRequest) {
  try {
    const { business } = await requireBusiness("staff.write");
    const rows = await db.select({ member: staffMembers, email: users.email })
      .from(staffMembers).innerJoin(users, eq(staffMembers.userId, users.id))
      .where(eq(staffMembers.businessId, business.id))
      .orderBy(desc(staffMembers.createdAt)).limit(200);
    return NextResponse.json({ staff: rows.map((row) => dto(row.member, row.email)) });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "staff-write", 20);
    const { user, business } = await requireBusiness("staff.write");
    const body = await readJson(request, BODY_LIMITS.staff);
    const email = textValue(body.email, 254).toLowerCase();
    const role = textValue(body.role, 20);
    if (!emailPattern.test(email) || !isStaffRole(role)) throw new ApiError("Enter a valid email and choose a role.");

    const [target] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!target) throw new ApiError("No account found with that email. Ask them to sign up first.", 404);
    if (target.id === business.ownerId || target.id === user.id) throw new ApiError("That account already owns this business.", 409);

    const [existing] = await db.select().from(staffMembers)
      .where(and(eq(staffMembers.businessId, business.id), eq(staffMembers.userId, target.id))).limit(1);
    if (existing?.status === "active") throw new ApiError("That person already has access.", 409);

    let row: typeof staffMembers.$inferSelect;
    if (existing) {
      [row] = await db.update(staffMembers)
        .set({ role, status: "active", invitedBy: user.id, updatedAt: new Date() })
        .where(eq(staffMembers.id, existing.id)).returning();
    } else {
      [row] = await db.insert(staffMembers)
        .values({ businessId: business.id, userId: target.id, role, invitedBy: user.id }).returning();
    }
    await recordAudit({ request, event: existing ? "staff.reinvited" : "staff.invited", outcome: "success", userId: user.id, email: target.email, businessId: business.id, detail: { role, targetUserId: target.id } });
    return NextResponse.json({ staff: dto(row, target.email) }, { status: existing ? 200 : 201 });
  } catch (error) { return fail(error, request); }
}

export async function PATCH(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "staff-write", 20);
    const { user, business } = await requireBusiness("staff.write");
    const body = await readJson(request, BODY_LIMITS.staff);
    const id = textValue(body.id, 50);
    if (!uuid.test(id)) throw new ApiError("Staff member not found.", 404);
    const [existing] = await db.select().from(staffMembers)
      .where(and(eq(staffMembers.id, id), eq(staffMembers.businessId, business.id))).limit(1);
    if (!existing) throw new ApiError("Staff member not found.", 404);

    let changes: Partial<typeof staffMembers.$inferInsert> = { updatedAt: new Date() };
    let event = "staff.role_changed";
    if (body.action === "remove") { changes.status = "removed"; event = "staff.removed"; }
    else if (body.action === "restore") { changes.status = "active"; event = "staff.reinvited"; }
    else if (body.action === undefined) {
      const role = textValue(body.role, 20);
      if (!isStaffRole(role)) throw new ApiError("Choose a valid role.");
      changes.role = role;
    } else throw new ApiError("Invalid staff action.");

    const [row] = await db.update(staffMembers).set(changes).where(eq(staffMembers.id, id)).returning();
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, existing.userId)).limit(1);
    await recordAudit({ request, event, outcome: "success", userId: user.id, email: target?.email, businessId: business.id, detail: { role: row.role, status: row.status, targetUserId: existing.userId } });
    return NextResponse.json({ staff: dto(row, target?.email ?? "") });
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "staff-write", 20);
    const { user, business } = await requireBusiness("staff.write");
    const body = await readJson(request, BODY_LIMITS.staff);
    const id = textValue(body.id, 50);
    if (!uuid.test(id)) throw new ApiError("Staff member not found.", 404);
    const [row] = await db.update(staffMembers)
      .set({ status: "removed", updatedAt: new Date() })
      .where(and(eq(staffMembers.id, id), eq(staffMembers.businessId, business.id))).returning();
    if (!row) throw new ApiError("Staff member not found.", 404);
    await recordAudit({ request, event: "staff.removed", outcome: "success", userId: user.id, businessId: business.id, detail: { targetUserId: row.userId } });
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error, request); }
}
