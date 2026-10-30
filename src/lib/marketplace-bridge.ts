import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { businessMarketplaceLinks } from "@/db/schema";
import { ApiError } from "@/lib/server";

const VERSION = "v1";
function encryptionKey(): Buffer {
  const secret = (process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (secret.length < 32) throw new ApiError("Marketplace token encryption is not configured on the Merchant App.", 503);
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptMarketplaceToken(token: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptMarketplaceToken(value: string): string {
  const [version, ivText, tagText, dataText] = value.split(".");
  if (version !== VERSION || !ivText || !tagText || !dataText) throw new ApiError("Marketplace connection credentials are invalid. Reconnect this business.", 503);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new ApiError("Marketplace connection credentials could not be decrypted. Check the token encryption key or reconnect this business.", 503);
  }
}

export async function getMarketplaceLink(businessId: string) {
  const [link] = await db.select().from(businessMarketplaceLinks).where(eq(businessMarketplaceLinks.businessId, businessId)).limit(1);
  return link ?? null;
}

export function marketplaceApiBase(): string {
  const raw = (process.env.MARKETPLACE_API_URL ?? "").trim();
  if (!raw) throw new ApiError("Marketplace URL is not configured on the Merchant App.", 503);
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError("Marketplace URL is invalid.", 503); }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new ApiError("Marketplace URL must use HTTPS in production.", 503);
  }
  return url.toString().replace(/\/$/, "");
}

export async function marketplaceFetch<T = any>(businessId: string, path: string, init: RequestInit = {}): Promise<T> {
  const link = await getMarketplaceLink(businessId);
  if (!link) throw new ApiError("Connect this business to your Marketplace listing first.", 409);
  const token = decryptMarketplaceToken(link.accessTokenEncrypted);
  const base = marketplaceApiBase();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(new URL(path, `${base}/`), { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError("Marketplace could not be reached. Your local workspace was not changed.", 502);
  }
  const payload = await response.json().catch(() => null) as (Record<string, unknown> | null);
  if (!response.ok) {
    const message = payload && typeof payload.error === "string" ? payload.error : "Marketplace request failed.";
    throw new ApiError(message, response.status >= 500 ? 502 : response.status);
  }
  return payload as T;
}

export async function saveMarketplaceLink(input: {
  businessId: string;
  accessToken: string;
  restaurant: { id: number; name: string; slug: string };
}) {
  const encrypted = encryptMarketplaceToken(input.accessToken);
  await db.insert(businessMarketplaceLinks).values({
    businessId: input.businessId,
    marketplaceRestaurantId: input.restaurant.id,
    marketplaceRestaurantName: input.restaurant.name,
    marketplaceRestaurantSlug: input.restaurant.slug,
    accessTokenEncrypted: encrypted,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: businessMarketplaceLinks.businessId,
    set: {
      marketplaceRestaurantId: input.restaurant.id,
      marketplaceRestaurantName: input.restaurant.name,
      marketplaceRestaurantSlug: input.restaurant.slug,
      accessTokenEncrypted: encrypted,
      updatedAt: new Date(),
    },
  });
}

export async function pairWithMarketplace(businessId: string, code: string) {
  const base = marketplaceApiBase();
  const secret = (process.env.MERCHANT_APP_INTEGRATION_SECRET ?? "").trim();
  if (secret.length < 32) throw new ApiError("Marketplace pairing secret is not configured on the Merchant App.", 503);
  if (!process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY || process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY.trim().length < 32) {
    throw new ApiError("Marketplace token encryption is not configured on the Merchant App.", 503);
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/integration/merchant/link", `${base}/`), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ businessId, code }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new ApiError("Marketplace could not be reached. Check the URL and try again.", 502); }
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || !payload?.ok || typeof payload.accessToken !== "string" || !payload.restaurant) {
    throw new ApiError(typeof payload?.error === "string" ? payload.error : "Marketplace pairing failed.", response.status >= 500 ? 502 : response.status || 502);
  }
  await saveMarketplaceLink({ businessId, accessToken: payload.accessToken, restaurant: payload.restaurant });
  return { name: payload.restaurant.name, slug: payload.restaurant.slug, id: payload.restaurant.id };
}
