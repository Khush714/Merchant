import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { businesses, sessions, users } from "@/db/schema";

const scrypt = promisify(scryptCallback);
const COOKIE = "savour_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex || !/^[a-f0-9]{128}$/.test(hex)) return false;
  const hash = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(hash, Buffer.from(hex, "hex"));
}
export async function createSession(userId: string, response: NextResponse) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) });
  response.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_SECONDS });
}
export async function deleteSession(response: NextResponse) {
  const token = (await cookies()).get(COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  response.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
}
export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const [result] = await db.select({ id: users.id, email: users.email }).from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  return result ?? null;
}
export class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new ApiError("Please sign in to continue.", 401);
  return user;
}
export async function requireBusiness() {
  const user = await requireUser();
  const [business] = await db.select().from(businesses).where(eq(businesses.ownerId, user.id)).limit(1);
  if (!business) throw new ApiError("Finish setting up your business first.", 404);
  return { user, business };
}
export function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (origin && host) {
    try { if (new URL(origin).host !== host) throw new ApiError("Invalid request origin.", 403); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError("Invalid request origin.", 403); }
  }
}
export function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("API error:", error);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}
const attempts = new Map<string, { count: number; until: number }>();
export function rateLimit(request: NextRequest, bucket: string, max = 30, windowMs = 60_000) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.until < now) attempts.set(key, { count: 1, until: now + windowMs });
  else if (++entry.count > max) throw new ApiError("Too many requests. Please try again shortly.", 429);
  if (attempts.size > 5000) for (const [k, value] of attempts) if (value.until < now) attempts.delete(k);
}
export function textValue(value: unknown, max = 200) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
export function withinOperatingHours(business: { hoursEnabled: boolean; opensAt: string; closesAt: string }) {
  if (!business.hoursEnabled) return true;
  const current = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  return business.opensAt <= business.closesAt ? current >= business.opensAt && current < business.closesAt : current >= business.opensAt || current < business.closesAt;
}
