/** Loopback URLs are safe for local `next start` validation; real production endpoints still require HTTPS. */
export function isLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}
