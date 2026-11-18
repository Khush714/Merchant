import type { NextRequest } from "next/server";
import { handleProviderWebhook } from "@/lib/provider-webhook";

export const dynamic = "force-dynamic";

/** Signed courier status updates. Signature is required; no browser session is used. */
export async function POST(request: NextRequest) {
  return handleProviderWebhook(request, "courier");
}
