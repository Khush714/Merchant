import "server-only";

import type { NextRequest } from "next/server";
import { ComplianceValidationError } from "@/lib/compliance-validation";
import { ApiError, fail, readJson, sha256 } from "@/lib/server";

/** Validation errors are user input; everything else keeps the standard API error shape. */
export function complianceFail(error: unknown, request?: NextRequest) {
  if (error instanceof ComplianceValidationError) return fail(new ApiError(error.message, 400), request);
  return fail(error, request);
}

/** A POST may legitimately carry no body (for example an invoice sync). */
export async function readOptionalJson<T = Record<string, unknown>>(request: NextRequest, maxBytes: number): Promise<T> {
  if (!request.body) return {} as T;
  return readJson<T>(request, maxBytes);
}

/** Hashes are recorded for the acceptance trail; raw IP and user agent are never stored. */
export function requestHashes(request: NextRequest) {
  const configured = (process.env.TRUSTED_PROXY_IP_HEADER ?? "").trim() || (process.env.VERCEL ? "x-vercel-forwarded-for" : "");
  const rawIp = configured ? request.headers.get(configured)?.split(",")[0]?.trim() ?? "" : "";
  const userAgent = request.headers.get("user-agent") ?? "";
  return { ipHash: rawIp ? sha256(rawIp) : "", userAgentHash: userAgent ? sha256(userAgent) : "" };
}
