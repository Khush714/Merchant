import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { accountTokens } from "@/db/schema";
import { sha256 } from "@/lib/server";

export type AccountTokenPurpose = "verify_email" | "reset_password";

// Verification links stay usable for a day; password resets are short lived.
const LIFETIMES_MINUTES: Record<AccountTokenPurpose, number> = { verify_email: 24 * 60, reset_password: 30 };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isAccountToken(value: string) { return TOKEN_PATTERN.test(value); }

/** Only the hash is stored. Issuing a new token invalidates earlier ones for the same purpose. */
export async function createAccountToken(userId: string, purpose: AccountTokenPurpose) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.delete(accountTokens).where(lt(accountTokens.expiresAt, now));
  await db.delete(accountTokens).where(and(eq(accountTokens.userId, userId), eq(accountTokens.purpose, purpose)));
  await db.insert(accountTokens).values({
    tokenHash: sha256(token),
    userId,
    purpose,
    expiresAt: new Date(now.getTime() + LIFETIMES_MINUTES[purpose] * 60_000),
  });
  return token;
}

/** Conditional update makes redemption atomic: one link can only ever be used once. */
export async function consumeAccountToken(token: string, purpose: AccountTokenPurpose) {
  if (!isAccountToken(token)) return null;
  const [row] = await db.update(accountTokens)
    .set({ consumedAt: new Date() })
    .where(and(
      eq(accountTokens.tokenHash, sha256(token)),
      eq(accountTokens.purpose, purpose),
      isNull(accountTokens.consumedAt),
      gt(accountTokens.expiresAt, new Date()),
    ))
    .returning({ userId: accountTokens.userId });
  return row?.userId ?? null;
}
