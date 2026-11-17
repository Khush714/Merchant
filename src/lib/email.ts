import type { NextRequest } from "next/server";
import { log, logError, warn } from "@/lib/telemetry";

const API_KEY = (process.env.RESEND_API_KEY ?? "").trim();
const FROM = (process.env.EMAIL_FROM ?? "").trim();
let warnedAboutConfig = false;
let warnedAboutOrigin = false;

/** Delivery is optional: missing credentials never break sign-up or password recovery. */
export function isEmailConfigured() { return Boolean(API_KEY && FROM); }

function originFor(request: NextRequest) {
  const canonical = (process.env.APP_ORIGIN ?? "").trim().replace(/\/$/, "");
  if (canonical) return canonical;
  if (process.env.NODE_ENV === "production" && !warnedAboutOrigin) {
    warnedAboutOrigin = true;
    warn("email.app_origin_missing", { note: "Using the request origin for account links; set APP_ORIGIN in production." });
  }
  return request.nextUrl.origin;
}

export function accountLink(request: NextRequest, path: string, token: string) {
  return `${originFor(request)}${path}?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string) { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

type Delivery = { sent: boolean; configured: boolean };

export async function sendAccountEmail(to: string, subject: string, text: string, html: string): Promise<Delivery> {
  if (!API_KEY || !FROM) {
    if (!warnedAboutConfig) {
      warnedAboutConfig = true;
      warn("email.not_configured", { note: "RESEND_API_KEY/EMAIL_FROM are unset; account emails are skipped." });
    }
    return { sent: false, configured: false };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      logError("email.send_failed", new Error(payload?.message || `Resend returned ${response.status}.`), { status: response.status });
      return { sent: false, configured: true };
    }
    log("email.sent", { subject });
    return { sent: true, configured: true };
  } catch (error) {
    logError("email.send_failed", error);
    return { sent: false, configured: true };
  }
}

export function sendVerificationEmail(request: NextRequest, to: string, token: string) {
  const link = accountLink(request, "/verify-email", token);
  const text = `Verify your Savour Partner email\n\nOpen this link within 24 hours to confirm your address:\n${link}\n\nIf you didn’t create this account, you can ignore this email.`;
  const html = `<p>Verify your Savour Partner email.</p><p>Open this link within 24 hours to confirm your address:</p><p><a href="${escapeHtml(link)}">Verify email</a></p><p>If you didn’t create this account, you can ignore this email.</p>`;
  return sendAccountEmail(to, "Verify your Savour Partner email", text, html);
}

export function sendPasswordResetEmail(request: NextRequest, to: string, token: string) {
  const link = accountLink(request, "/reset-password", token);
  const text = `Reset your Savour Partner password\n\nOpen this link within 30 minutes to choose a new password:\n${link}\n\nIf you didn’t request this, you can ignore this email and your password will stay unchanged.`;
  const html = `<p>Reset your Savour Partner password.</p><p>Open this link within 30 minutes to choose a new password:</p><p><a href="${escapeHtml(link)}">Reset password</a></p><p>If you didn’t request this, you can ignore this email and your password will stay unchanged.</p>`;
  return sendAccountEmail(to, "Reset your Savour Partner password", text, html);
}
