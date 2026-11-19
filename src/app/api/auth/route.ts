import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { consumeAccountToken, createAccountToken, isAccountToken } from "@/lib/account-tokens";
import { isEmailConfigured, sendPasswordResetEmail, sendVerificationEmail } from "@/lib/email";
import { getMarketplaceLink } from "@/lib/marketplace-bridge";
import { ApiError, BODY_LIMITS, businessForUser, businessesForUser, changePassword, createSession, currentUser, deleteAllSessions, deleteSession, fail, hashPassword, rateLimit, readJson, recordAudit, requireUser, sameOrigin, sessionContext, textValue, verificationRequired, verifyPassword } from "@/lib/server";
import type { BusinessOption } from "@/lib/types";

export const dynamic = "force-dynamic";

function authUser(record: { id: string; email: string; emailVerifiedAt: Date | null }) {
  return { id: record.id, email: record.email, emailVerified: record.emailVerifiedAt !== null };
}

/** A paired Marketplace listing is already live; the local approval flag only tracks unlinked setup. */
async function withListingStatus<T extends { id: string; approvalStatus: string }>(business: T | undefined | null, linked?: boolean) {
  if (!business) return null;
  const isLinked = linked ?? Boolean(await getMarketplaceLink(business.id));
  return isLinked ? { ...business, approvalStatus: "approved" as const } : business;
}

/** Builds the auth payload for a user. A null active id means "use this account's first outlet". */
export async function listingFor(userId: string, activeBusinessId?: string | null) {
  const [active, available] = await Promise.all([
    businessForUser(userId, activeBusinessId),
    businessesForUser(userId),
  ]);
  const options: BusinessOption[] = await Promise.all(available.map(async ({ business, role }) => {
    const linked = Boolean(await getMarketplaceLink(business.id));
    return {
      id: business.id,
      name: business.name,
      type: business.type as BusinessOption["type"],
      approvalStatus: linked ? "approved" : business.approvalStatus as BusinessOption["approvalStatus"],
      isOpen: business.isOpen,
      role,
      linked,
    };
  }));
  const business = active
    ? await withListingStatus(active.business, options.find((option) => option.id === active.business.id)?.linked)
    : null;
  return { business, role: active?.role ?? null, businesses: options };
}

export async function GET(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ user: null, business: null, role: null, businesses: [], verificationRequired: verificationRequired() });
    const context = await sessionContext();
    return NextResponse.json({ user, ...(await listingFor(user.id, context?.activeBusinessId)), verificationRequired: verificationRequired() });
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
      const user = await requireUser({ allowUnverified: true });
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
      const user = await requireUser({ allowUnverified: true });
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
      const response = NextResponse.json({ user: authUser(user), business: null, role: null, businesses: [], verificationRequired: verificationRequired() }, { status: 201 });
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
      // A fresh session starts with no outlet selection, so use the account's default outlet.
      const response = NextResponse.json({ user: authUser(record), ...(await listingFor(record.id, null)), verificationRequired: verificationRequired() });
      await createSession(record.id, response);
      await recordAudit({ request, event: "auth.login", outcome: "success", userId: record.id, email: record.email });
      return response;
    }
    throw new ApiError("Unknown action.");
  } catch (error) { return fail(error, request); }
}
