import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/server";
import { isLoopbackUrl, resolveStorageSignedUrl } from "@/lib/urls";

const VERSION = "v1";
const BUCKET = /^[A-Za-z0-9_.-]{1,100}$/;

function config() {
  const raw = (process.env.SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!raw || !serviceKey) throw new ApiError("Private document storage is not configured on the Merchant App.", 503);
  let base: URL;
  try { base = new URL(raw); } catch { throw new ApiError("SUPABASE_URL is invalid.", 503); }
  if (base.protocol !== "https:" && process.env.NODE_ENV === "production" && !isLoopbackUrl(base)) {
    throw new ApiError("SUPABASE_URL must use HTTPS in production.", 503);
  }
  if (base.pathname !== "/" || base.search || base.hash) throw new ApiError("SUPABASE_URL must be a bare origin.", 503);
  if (serviceKey.length < 32) throw new ApiError("SUPABASE_SERVICE_ROLE_KEY is invalid.", 503);
  const bucket = (process.env.COMPLIANCE_STORAGE_BUCKET ?? "merchant-compliance").trim();
  if (!BUCKET.test(bucket)) throw new ApiError("COMPLIANCE_STORAGE_BUCKET is invalid.", 503);
  return { base: base.toString().replace(/\/$/, ""), serviceKey, bucket };
}

export function documentStorageConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? "").trim() && (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim());
}

/** Domain separation keeps document bytes unreadable with the Marketplace token key. */
function encryptionKey(): Buffer {
  const secret = (process.env.MERCHANT_APP_TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (secret.length < 32) throw new ApiError("Document encryption is not configured on the Merchant App.", 503);
  return createHash("sha256").update("savour-compliance-document-v1\0").update(secret, "utf8").digest();
}

export function encryptDocument(bytes: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptDocument(value: string): Buffer {
  const [version, ivText, tagText, dataText] = value.split(".");
  if (version !== VERSION || !ivText || !tagText || !dataText) throw new ApiError("Stored document is invalid.", 503);
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]);
  } catch {
    throw new ApiError("Stored document could not be decrypted. Check the document encryption key.", 503);
  }
}

export function newStorageKey(businessId: string, kind: string, fileName: string): string {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "document";
  return `${businessId}/${kind}/${randomUUID()}-${safeName}`;
}

function encodedPath(storageKey: string): string {
  return storageKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function storageFetch(path: string, init: RequestInit): Promise<Response> {
  const { base, serviceKey } = config();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${serviceKey}`);
  headers.set("apikey", serviceKey);
  try {
    return await fetch(new URL(path, `${base}/`), {
      ...init,
      headers,
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError("Private document storage could not be reached.", 502);
  }
}

async function storageError(response: Response, fallback: string): Promise<never> {
  const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  throw new ApiError(payload?.message ?? payload?.error ?? fallback, response.status >= 500 ? 502 : response.status);
}

export async function uploadDocumentObject(storageKey: string, encrypted: Uint8Array): Promise<void> {
  const { bucket } = config();
  const response = await storageFetch(`/storage/v1/object/${bucket}/${encodedPath(storageKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "cache-control": "no-store", "x-upsert": "false" },
    body: new Uint8Array(encrypted),
  });
  if (!response.ok) await storageError(response, "The encrypted document could not be stored.");
}

/** The browser never sees storage credentials; the server uses a 60-second signed URL and proxies bytes. */
export async function downloadDocumentObject(storageKey: string): Promise<Buffer> {
  const { base, bucket } = config();
  const path = encodedPath(storageKey);
  const signed = await storageFetch(`/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  if (!signed.ok) await storageError(signed, "A private document link could not be created.");
  const payload = await signed.json().catch(() => null) as { signedURL?: string; signedUrl?: string } | null;
  const signedPath = payload?.signedURL ?? payload?.signedUrl;
  if (!signedPath) throw new ApiError("Private document storage returned an invalid link.", 502);
  let signedUrl: URL;
  try { signedUrl = resolveStorageSignedUrl(signedPath, base); } catch { throw new ApiError("Private document storage returned an invalid link.", 502); }
  let response: Response;
  try {
    response = await fetch(signedUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch { throw new ApiError("The private document could not be downloaded.", 502); }
  if (!response.ok) await storageError(response, "The private document could not be downloaded.");
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteDocumentObject(storageKey: string): Promise<void> {
  const { bucket } = config();
  const response = await storageFetch(`/storage/v1/object/${bucket}/${encodedPath(storageKey)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) await storageError(response, "The stored document could not be removed.");
}
