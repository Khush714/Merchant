import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { businesses, sessions, users } from "@/db/schema";

const scrypt = promisify(scryptCallback);
const COOKIE = "savour_session";
const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 90;
const SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24;
const MAX_SESSIONS = 10;

export const BODY_LIMITS = {
  auth: 16 * 1024,
  admin: 8 * 1024,
  business: 32 * 1024,
  menu: 64 * 1024,
  orders: 16 * 1024,
  marketplace: 128 * 1024,
  marketplaceLink: 8 * 1024,
} as const;

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
function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
}
/** Drop expired tokens and keep only the newest sessions so one account cannot accumulate unlimited live sessions. */
async function trimSessions(userId: string) {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, new Date())));
  const newest = await db.select({ tokenHash: sessions.tokenHash }).from(sessions)
    .where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt)).limit(MAX_SESSIONS);
  if (newest.length < MAX_SESSIONS) return;
  await db.delete(sessions).where(and(eq(sessions.userId, userId), notInArray(sessions.tokenHash, newest.map((session) => session.tokenHash))));
}
export async function createSession(userId: string, response: NextResponse) {
  const token = randomBytes(32).toString("hex");
  // Rotate any token already present in this browser so it cannot survive a fresh sign-in.
  const previous = (await cookies()).get(COOKIE)?.value;
  if (previous) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(previous)));
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + SESSION_IDLE_SECONDS * 1000) });
  await trimSessions(userId);
  response.cookies.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_ABSOLUTE_SECONDS });
}
export async function deleteSession(response: NextResponse) {
  const token = (await cookies()).get(COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  clearSessionCookie(response);
}
/** Sign out every browser for the current account. */
export async function deleteAllSessions(response: NextResponse) {
  const user = await currentUser();
  if (user) await db.delete(sessions).where(eq(sessions.userId, user.id));
  clearSessionCookie(response);
}
/** Replace the password hash, revoke every existing session and issue a fresh session for this browser. */
export async function changePassword(userId: string, passwordHash: string, response: NextResponse) {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await createSession(userId, response);
}
export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const tokenHash = sha256(token);
  const now = new Date();
  const [result] = await db.select({ id: users.id, email: users.email, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt }).from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash)).limit(1);
  if (!result) return null;
  const absoluteExpiry = result.createdAt.getTime() + SESSION_ABSOLUTE_SECONDS * 1000;
  if (result.expiresAt <= now || absoluteExpiry <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  // Slide the idle timeout forward, at most once per renewal window and never past the absolute lifetime.
  if (result.expiresAt.getTime() < now.getTime() + (SESSION_IDLE_SECONDS - SESSION_RENEW_AFTER_SECONDS) * 1000) {
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_SECONDS * 1000, absoluteExpiry));
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.tokenHash, tokenHash));
  }
  return { id: result.id, email: result.email };
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
  if (!origin) return;
  let originUrl: URL;
  try { originUrl = new URL(origin); } catch { throw new ApiError("Invalid request origin.", 403); }
  const canonical = (process.env.APP_ORIGIN ?? "").trim();
  if (canonical) {
    let canonicalUrl: URL;
    try { canonicalUrl = new URL(canonical); } catch { throw new ApiError("APP_ORIGIN is not configured correctly.", 500); }
    if (originUrl.origin !== canonicalUrl.origin) throw new ApiError("Invalid request origin.", 403);
    return;
  }
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host && originUrl.host !== host) throw new ApiError("Invalid request origin.", 403);
}
export function fail(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("API error:", error);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}
const attempts = new Map<string, { count: number; until: number }>();
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "").trim().replace(/\/$/, "");
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "").trim();
const SHARED_RATE_LIMIT = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
let warnedAboutMemoryLimiter = false;
const RATE_LIMIT_SCRIPT = `local current = redis.call("INCR", KEYS[1])
if current == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return current`;

/** Only trust a client-IP header that a trusted proxy overwrites. Vercel injects x-vercel-forwarded-for. */
function clientIp(request: NextRequest) {
  const configuredHeader = (process.env.TRUSTED_PROXY_IP_HEADER ?? "").trim();
  const header = configuredHeader || (process.env.VERCEL ? "x-vercel-forwarded-for" : "");
  if (!header) return process.env.NODE_ENV === "production" ? "untrusted" : "local";
  const candidate = request.headers.get(header)?.split(",")[0]?.trim() ?? "";
  return isIP(candidate) ? candidate : "unknown";
}
function memoryRateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.until < now) attempts.set(key, { count: 1, until: now + windowMs });
  else if (++entry.count > max) throw new ApiError("Too many requests. Please try again shortly.", 429);
  if (attempts.size > 5000) for (const [k, value] of attempts) if (value.until < now) attempts.delete(k);
}
async function sharedRateLimit(key: string, windowMs: number) {
  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(["EVAL", RATE_LIMIT_SCRIPT, "1", key, String(windowMs)]),
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  const payload = (await response.json().catch(() => null)) as { result?: unknown; error?: string } | null;
  const count = Number(payload?.result);
  if (!response.ok || payload?.error || !Number.isSafeInteger(count)) {
    throw new Error(payload?.error || `Rate limit store returned ${response.status}.`);
  }
  return count;
}
export async function rateLimit(request: NextRequest, bucket: string, max = 30, windowMs = 60_000) {
  const key = `savour:rate:${bucket}:${sha256(clientIp(request))}`;
  if (SHARED_RATE_LIMIT) {
    try {
      const count = await sharedRateLimit(key, windowMs);
      if (count > max) throw new ApiError("Too many requests. Please try again shortly.", 429);
      return;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error("Shared rate limit store unavailable; falling back to per-instance limiting.", error);
    }
  } else if (!warnedAboutMemoryLimiter) {
    warnedAboutMemoryLimiter = true;
    console.warn("UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not configured; rate limiting is per-instance.");
  }
  memoryRateLimit(key, max, windowMs);
}
export async function readJson<T = Record<string, any>>(request: NextRequest, maxBytes = 64 * 1024): Promise<T> {
  const contentType = request.headers.get("content-type");
  if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ApiError("Send the request body as JSON.", 415);
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError("Request body is too large.", 413);
  if (!request.body) throw new ApiError("Request body is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiError("Request body is too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* The stream may already be cancelled. */ }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (!text.trim()) throw new ApiError("Request body is required.", 400);
  try { return JSON.parse(text) as T; }
  catch { throw new ApiError("Invalid JSON request body.", 400); }
}
export function textValue(value: unknown, max = 200) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
export function withinOperatingHours(business: { hoursEnabled: boolean; opensAt: string; closesAt: string }) {
  if (!business.hoursEnabled) return true;
  const current = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  return business.opensAt <= business.closesAt ? current >= business.opensAt && current < business.closesAt : current >= business.opensAt || current < business.closesAt;
}
