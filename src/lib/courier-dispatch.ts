import "server-only";

import type { NextRequest } from "next/server";
import { providerSignature } from "@/lib/provider-events";
import { recordAudit } from "@/lib/server";
import { isLoopbackUrl } from "@/lib/urls";

export type CourierDispatchResult = { sent: boolean; reason: "not_configured" | "misconfigured" | "unreachable" | "rejected" | "sent" };

/**
 * Outbound seam for a courier provider. Sending is best-effort: the merchant's local status change
 * is already committed, and a provider failure is audited rather than silently rolling back the handoff.
 */
export async function dispatchCourierAssignment(request: NextRequest, order: {
  id: string; orderNumber: number; businessId: string; customerName: string; deliveryAddress: string; total: number;
  items: { name: string; quantity: number }[];
}): Promise<CourierDispatchResult> {
  const rawUrl = (process.env.COURIER_DISPATCH_URL ?? "").trim();
  const secret = (process.env.COURIER_DISPATCH_SECRET ?? "").trim();
  if (!rawUrl || !secret) return { sent: false, reason: "not_configured" };
  const fail = async (reason: CourierDispatchResult["reason"]) => {
    await recordAudit({ request, event: "courier.dispatch", outcome: "failure", businessId: order.businessId, detail: { orderId: order.id, reason } });
    return { sent: false, reason } as CourierDispatchResult;
  };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return fail("misconfigured"); }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production" && !isLoopbackUrl(url)) return fail("misconfigured");
  if (secret.length < 32) return fail("misconfigured");

  // A stable event id lets the provider dedupe retries of the same handoff.
  const payload = {
    eventId: `dispatch_${order.id}`, type: "delivery.dispatch", businessId: order.businessId,
    orderId: order.id, orderNumber: order.orderNumber, customerName: order.customerName,
    deliveryAddress: order.deliveryAddress, totalPaise: order.total,
    items: order.items.map((item) => ({ name: item.name, quantity: item.quantity })),
  };
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = providerSignature(secret, body, timestamp);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-savour-signature": `t=${timestamp},v1=${signature}` },
      body, cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
  } catch { return fail("unreachable"); }
  if (!response.ok) return fail("rejected");
  await recordAudit({ request, event: "courier.dispatch", outcome: "success", businessId: order.businessId, detail: { orderId: order.id, reason: "sent" } });
  return { sent: true, reason: "sent" };
}
