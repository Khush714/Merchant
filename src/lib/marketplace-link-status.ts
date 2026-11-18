/** Machine-readable marker returned with an upstream Marketplace 401. */
export const MARKETPLACE_LINK_INVALID = "MARKETPLACE_LINK_INVALID";

/**
 * Duck-typed so this helper stays importable from plain Node tests without pulling in
 * the server module graph. Only a definitive upstream rejection marks the link invalid;
 * transport or server failures leave validity unknown so we never prompt a needless re-pair.
 */
export function isInvalidMarketplaceLinkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 401 && candidate.code === MARKETPLACE_LINK_INVALID;
}
