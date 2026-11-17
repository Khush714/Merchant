import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ApiError, rateLimit, recordAudit, sha256 } from "@/lib/server";

/** Shared bearer-token check for server-to-service administrative hooks. */
export async function requireAdmin(request: NextRequest, event: string, bucket = "admin") {
  await rateLimit(request, bucket, 20);
  const configured = process.env.MARKETPLACE_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expectedHash = Buffer.from(sha256(configured || ""), "hex");
  const suppliedHash = Buffer.from(sha256(supplied), "hex");
  if (!configured || !supplied || expectedHash.length !== suppliedHash.length || !timingSafeEqual(expectedHash, suppliedHash)) {
    await recordAudit({ request, event, outcome: "denied", detail: { reason: "invalid_token" } });
    throw new ApiError("Not authorised.", 403);
  }
}
