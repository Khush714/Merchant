import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, users } from "@/db/schema";
import { ApiError, createSession, currentUser, deleteSession, fail, hashPassword, rateLimit, sameOrigin, textValue, verifyPassword } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ user: null, business: null });
    const [business] = await db.select().from(businesses).where(eq(businesses.ownerId, user.id)).limit(1);
    return NextResponse.json({ user, business: business ?? null });
  } catch (error) { return fail(error); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    rateLimit(request, "auth", 15, 60_000);
    const body = await request.json();
    if (body.action === "logout") {
      const response = NextResponse.json({ ok: true });
      await deleteSession(response);
      return response;
    }
    const email = textValue(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) throw new ApiError("Enter a valid email and a password of 8–128 characters.");
    if (body.action === "register") {
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length) throw new ApiError("An account with this email already exists.", 409);
      const passwordHash = await hashPassword(password);
      const [user] = await db.insert(users).values({ email, passwordHash }).onConflictDoNothing().returning({ id: users.id, email: users.email });
      if (!user) throw new ApiError("An account with this email already exists.", 409);
      const response = NextResponse.json({ user, business: null }, { status: 201 });
      await createSession(user.id, response);
      return response;
    }
    if (body.action === "login") {
      const [record] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!record || !(await verifyPassword(password, record.passwordHash))) throw new ApiError("Incorrect email or password.", 401);
      const [business] = await db.select().from(businesses).where(eq(businesses.ownerId, record.id)).limit(1);
      const response = NextResponse.json({ user: { id: record.id, email: record.email }, business: business ?? null });
      await createSession(record.id, response);
      return response;
    }
    throw new ApiError("Unknown action.");
  } catch (error) { return fail(error); }
}
