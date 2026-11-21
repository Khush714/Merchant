import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { ProviderEventError, parseProviderEvent, verifyProviderSignature, type ProviderKind } from "@/lib/provider-events";
import { applyProviderEvent } from "@/lib/provider-events-service";
import { ApiError, BODY_LIMITS, fail, rateLimit, readRawBody, recordAudit, sha256 } from "@/lib/server";

function secretFor(provider: ProviderKind) {
  return provider === "courier" ? process.env.COURIER_WEBHOOK_SECRET : process.env.PAYMENT_WEBHOOK_SECRET;
}

/** Shared intake for signed provider events: raw-body HMAC, strict validation, then an idempotent apply. */
export async function handleProviderWebhook(request: NextRequest, provider: ProviderKind) {
  try {
    await rateLimit(request, `provider-${provider}`, 60);
    const secret = secretFor(provider)?.trim() ?? "";
    if (secret.length < 32) throw new ApiError("Provider webhook secret is not configured on the Merchant App.", 503);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      throw new ApiError("Send a JSON body.", 415);
    }
    const rawBody = await readRawBody(request, BODY_LIMITS.providerEvent, "Event payload is too large.");
    try {
      verifyProviderSignature(secret, rawBody, request.headers.get("x-savour-signature"));
    } catch (error) {
      if (error instanceof ProviderEventError) {
        await recordAudit({ request, event: "provider_event.rejected", outcome: "denied", detail: { provider, reason: error.message } });
        throw new ApiError(error.message, 401);
      }
      throw error;
    }
    let payload: unknown;
    try { payload = JSON.parse(rawBody); } catch { throw new ApiError("Event payload is not valid JSON.", 400); }
    let event;
    try { event = parseProviderEvent(provider, payload); }
    catch (error) {
      if (error instanceof ProviderEventError) throw new ApiError(error.message, 400);
      throw error;
    }
    const result = await applyProviderEvent(request, event, sha256(rawBody));
    return NextResponse.json({ received: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(error, request); }
}
