/** Loopback URLs are safe for local `next start` validation; real production endpoints still require HTTPS. */
export function isLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

/**
 * Supabase Storage returns `signedURL` as a path relative to its API root
 * (for example `/object/sign/bucket/key?token=...`), not to the project origin.
 * Resolve it against `${origin}/storage/v1`, matching the storage-js SDK;
 * an already-absolute URL is returned unchanged.
 */
export function resolveStorageSignedUrl(signedPath: string, origin: string): URL {
  const value = signedPath.trim();
  if (/^https?:\/\//i.test(value)) return new URL(value);
  const path = value.startsWith("/") ? value : `/${value}`;
  const root = origin.replace(/\/+$/, "");
  const prefix = "/storage/v1";
  return new URL(path.startsWith(`${prefix}/`) ? `${root}${path}` : `${root}${prefix}${path}`);
}
