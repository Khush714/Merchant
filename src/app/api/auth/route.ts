import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { businesses, users } from "@/db/schema";
import { consumeAccountToken, createAccountToken, isAccountToken } from "@/lib/account-tokens";
import { isEmailConfigured, sendPasswordResetEmail, sendVerificationEmail } from "@/lib/email";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, changePassword, createSession, currentUser, deleteAllSessions, deleteSession, fail, hashPassword, rateLimit, readJson, recordAudit, requireUser, sameOrigin, textValue, verifyPassword } from "@/lib/server";

export const dynamic = "force-dynamic";

function authUser(record: { id: string; email: string; emailVerifiedAt: Date | null }) {
  return { id: record.id, email: record.email, emailVerified: record.emailVerifiedAt !== null };
}

/** A paired Marketplace listing is already live; the local approval flag only tracks unlinked setup. */
async function withListingStatus<T extends { id: string; approvalStatus: string }>(business: T | undefined | null) {
  if (!business) return null;
  return (await getMarketplaceLink(business.id)) ? { ...business, approvalStatus: "approved" as const } : business;
}

export async function GET(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ user: null, business: null });
    const [business] = await db.select().from(businesses).where(eq(businesses.ownerId, user.id)).limit(1);
    return NextResponse.json({ user, business: await withListingStatus(business) });
  } catch (error) { return fail(error, request); }
}
export async function POST(request: NextRequest) {
  try {
    sameOrigin(request);
    await rateLimit(request, "auth", 15, 60_000);
    const body = await readJson(request, BODY_LIMITS.auth);
    if (body.action === "logout") {
      const user = await currentUser();
      const response = NextResponse.json({ ok: true });
      await deleteSession(response);
      await recordAudit({ request, event: "auth.logout", outcome: "success", userId: user?.id, email: user?.email });
      return response;
    }
    if (body.action === "logout-all") {
      const user = await currentUser();
      const response = NextResponse.json({ ok: true });
      await deleteAllSessions(response);
      await recordAudit({ request, event: "auth.logout_all", outcome: "success", userId: user?.id, email: user?.email });
      return response;
    }
    if (body.action === "verify-email") {
      const token = textValue(body.token, 128);
      if (!isAccountToken(token)) {
        await recordAudit({ request, event: "auth.verify_email", outcome: "failure", detail: { reason: "invalid_format" } });
        throw new ApiError("This verification link is invalid or has expired.");
      }
      const userId = await consumeAccountToken(token, "verify_email");
      if (!userId) {
        await recordAudit({ request, event: "auth.verify_email", outcome: "failure", detail: { reason: "invalid_token" } });
        throw new ApiError("This verification link is invalid or has expired.");
      }
      await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
      await recordAudit({ request, event: "auth.verify_email", outcome: "success", userId });
      return NextResponse.json({ ok: true, emailVerified: true });
    }
    if (body.action === "resend-verification") {
      const user = await requireUser();
      if (user.emailVerified) return NextResponse.json({ ok: true, sent: false, configured: isEmailConfigured() });
      const token = await createAccountToken(user.id, "verify_email");
      const delivery = await sendVerificationEmail(request, user.email, token);
      await recordAudit({ request, event: "auth.resend_verification", outcome: "success", userId: user.id, email: user.email, detail: { sent: delivery.sent } });
      return NextResponse.json({ ok: true, ...delivery });
    }
    if (body.action === "forgot-password") {
      const email = textValue(body.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("Enter a valid email address.");
      const [record] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email)).limit(1);
      let delivery = { sent: false, configured: isEmailConfigured() };
      if (record) {
        const token = await createAccountToken(record.id, "reset_password");
        delivery = await sendPasswordResetEmail(request, record.email, token);
      }
      // Always answer the same way so an unknown address cannot be distinguished from a known one.
      await recordAudit({ request, event: "auth.forgot_password", outcome: "success", email, detail: { ...delivery, accountFound: Boolean(record) } });
      return NextResponse.json({ ok: true, ...delivery });
    }
    if (body.action === "reset-password") {
      const token = textValue(body.token, 128);
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8 || password.length > 128) throw new ApiError("Choose a new password of 8–128 characters.");
      const userId = isAccountToken(token) ? await consumeAccountToken(token, "reset_password") : null;
      if (!userId) {
        await recordAudit({ request, event: "auth.reset_password", outcome: "failure", detail: { reason: "invalid_token" } });
        throw new ApiError("This reset link is invalid or has expired.");
      }
      const response = NextResponse.json({ ok: true });
      await changePassword(userId, await hashPassword(password), response);
      await recordAudit({ request, event: "auth.reset_password", outcome: "success", userId, detail: { sessionsRevoked: true } });
      return response;
    }
    if (body.action === "change-password") {
      const user = await requireUser();
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      if (newPassword.length < 8 || newPassword.length > 128) throw new ApiError("Choose a new password of 8–128 characters.");
      if (newPassword === currentPassword) throw new ApiError("Choose a new password different from your current one.");
      const [record] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).limit(1);
      if (!record || !(await verifyPassword(currentPassword, record.passwordHash))) {
        await recordAudit({ request, event: "auth.change_password", outcome: "failure", userId: user.id, email: user.email, detail: { reason: "invalid_current_password" } });
        throw new ApiError("Your current password is incorrect.", 403);
      }
      const response = NextResponse.json({ ok: true });
      await changePassword(user.id, await hashPassword(newPassword), response);
      await recordAudit({ request, event: "auth.change_password", outcome: "success", userId: user.id, email: user.email, detail: { sessionsRevoked: true } });
      return response;
    }
    const email = textValue(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) throw new ApiError("Enter a valid email and a password of 8–128 characters.");
    if (body.action === "register") {
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length) {
        await recordAudit({ request, event: "auth.register", outcome: "failure", email, detail: { reason: "email_exists" } });
        throw new ApiError("An account with this email already exists.", 409);
      }
      const passwordHash = await hashPassword(password);
      const [user] = await db.insert(users).values({ email, passwordHash }).onConflictDoNothing().returning({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt });
      if (!user) {
        await recordAudit({ request, event: "auth.register", outcome: "failure", email, detail: { reason: "email_exists" } });
        throw new ApiError("An account with this email already exists.", 409);
      }
      const token = await createAccountToken(user.id, "verify_email");
      const delivery = await sendVerificationEmail(request, user.email, token);
      const response = NextResponse.json({ user: authUser(user), business: null }, { status: 201 });
      await createSession(user.id, response);
      await recordAudit({ request, event: "auth.register", outcome: "success", userId: user.id, email: user.email, detail: { verificationSent: delivery.sent } });
      return response;
    }
    if (body.action === "login") {
      const [record] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (!record || !(await verifyPassword(password, record.passwordHash))) {
        await recordAudit({ request, event: "auth.login", outcome: "failure", email, detail: { reason: "invalid_credentials" } });
        throw new ApiError("Incorrect email or password.", 401);
      }
      const [business] = await db.select().from(businesses).where(eq(businesses.ownerId, record.id)).limit(1);
      const response = NextResponse.json({ user: authUser(record), business: await withListingStatus(business) });
      await createSession(record.id, response);
      await recordAudit({ request, event: "auth.login", outcome: "success", userId: record.id, email: record.email });
      return response;
    }
    throw new ApiError("Unknown action.");
  } catch (error) { return fail(error, request); }
}
