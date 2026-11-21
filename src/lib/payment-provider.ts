import "server-only";

import {
  checkoutSignature, gatewayCredentials, gatewayMode, providerReceipt, RAZORPAY_API,
  razorpayAuthorization, verifyCheckoutSignature, type GatewayMode,
} from "@/lib/payment-provider-core";
import { ApiError } from "@/lib/server";

/**
 * Provider-agnostic gateway adapter for unpaired outlets. Paired outlets never call it.
 * Razorpay is the live implementation; the dev mode is a labelled simulator that moves no money.
 */

export type CheckoutSession = {
  mode: GatewayMode;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: "INR";
  notice: string;
};

export type CapturedPayment = {
  mode: GatewayMode;
  reference: string;
  captured: boolean;
  notice: string;
};

export type ProviderRefund = {
  mode: GatewayMode;
  reference: string;
  notice: string;
};

function mode(): GatewayMode {
  return gatewayMode();
}

async function providerFetch(path: string, init: RequestInit = {}) {
  const { keyId, keySecret } = gatewayCredentials();
  const headers = new Headers(init.headers);
  headers.set("Authorization", razorpayAuthorization(keyId, keySecret));
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(`${RAZORPAY_API}${path}`, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(10_000) });
  } catch {
    throw new ApiError("The payment provider could not be reached. No local money state was changed.", 502);
  }
  const payload = await response.json().catch(() => null) as (Record<string, any> | null);
  if (!response.ok) {
    const detail = payload?.error?.description ?? payload?.error?.reason ?? "Payment provider request failed.";
    throw new ApiError(String(detail).slice(0, 300), response.status >= 500 ? 502 : 422);
  }
  return payload ?? {};
}

/** Create a provider order for a local attempt; idempotency is keyed by the attempt id. */
export async function createCheckout(input: {
  businessId: string;
  orderNumber: number;
  attemptId: string;
  amountPaise: number;
}): Promise<CheckoutSession> {
  const current = mode();
  if (current === "unavailable") {
    throw new ApiError("Online payments are not configured for unpaired outlets. Connect this outlet to Marketplace or configure gateway credentials.", 503);
  }
  const receipt = providerReceipt(input.businessId, input.orderNumber, input.attemptId);
  if (current === "dev") {
    return {
      mode: "dev", providerOrderId: `dev_order_${input.attemptId}`, keyId: "dev",
      amountPaise: input.amountPaise, currency: "INR",
      notice: "SIMULATOR: no real payment was requested and no money will move. Use the dev reference to confirm this attempt as a test.",
    };
  }
  const { keyId } = gatewayCredentials();
  const providerOrder = await providerFetch("/orders", {
    method: "POST",
    headers: { "X-Razorpay-Idempotency-Key": `merchant_checkout_${input.attemptId}` },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: "INR",
      receipt,
      notes: { merchantAttemptId: input.attemptId, businessId: input.businessId },
    }),
  });
  if (typeof providerOrder.id !== "string" || !providerOrder.id) throw new ApiError("The payment provider returned no order id.", 502);
  return {
    mode: "razorpay", providerOrderId: providerOrder.id, keyId,
    amountPaise: input.amountPaise, currency: "INR",
    notice: "Verify the payment with the provider signature returned by checkout.",
  };
}

/** Verify a browser checkout result and capture the authorised payment before marking it paid. */
export async function confirmCheckout(input: {
  attemptId: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
  devReference: string;
  amountPaise: number;
}): Promise<CapturedPayment> {
  const current = mode();
  if (current === "unavailable") throw new ApiError("Online payments are not configured for unpaired outlets.", 503);
  if (current === "dev") {
    const reference = input.devReference.trim().slice(0, 128);
    if (!reference) throw new ApiError("Enter a dev reference to simulate a confirmed payment.");
    return {
      mode: "dev", reference, captured: true,
      notice: "SIMULATOR: this confirmation records a test payment only. No gateway was contacted and no money moved.",
    };
  }
  const { keySecret } = gatewayCredentials();
  if (!input.signature || !verifyCheckoutSignature(keySecret, input.providerOrderId, input.providerPaymentId, input.signature)) {
    throw new ApiError("Payment signature verification failed.", 422);
  }
  // Defender-in-depth: even a correctly signed response must belong to this order and amount.
  const payment = await providerFetch(`/payments/${encodeURIComponent(input.providerPaymentId)}`);
  if (payment.order_id !== input.providerOrderId || Number(payment.amount) !== input.amountPaise) {
    throw new ApiError("The confirmed payment does not match this order.", 422);
  }
  let captured = payment.captured === true;
  if (!captured) {
    const result = await providerFetch(`/payments/${encodeURIComponent(input.providerPaymentId)}/capture`, {
      method: "POST",
      headers: { "X-Razorpay-Idempotency-Key": `merchant_capture_${input.attemptId}` },
      body: JSON.stringify({ amount: input.amountPaise, currency: "INR" }),
    });
    captured = result.captured === true;
  }
  if (!captured) throw new ApiError("The provider did not confirm capture of this payment.", 502);
  return { mode: "razorpay", reference: input.providerPaymentId, captured: true, notice: "Payment captured by the provider." };
}

/** Initiate a provider refund. Approved local refunds only; paired outlets stay upstream. */
export async function refundPayment(input: {
  providerPaymentId: string;
  amountPaise: number;
  refundId: string;
}): Promise<ProviderRefund> {
  const current = mode();
  if (current === "unavailable") throw new ApiError("No payment gateway is configured. Record this refund after it is processed externally.", 503);
  if (current === "dev") {
    return {
      mode: "dev", reference: `dev_refund_${input.refundId}`,
      notice: "SIMULATOR: no refund was sent to a gateway and no money was returned.",
    };
  }
  const result = await providerFetch(`/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
    method: "POST",
    headers: { "X-Razorpay-Idempotency-Key": `merchant_refund_${input.refundId}` },
    body: JSON.stringify({ amount: input.amountPaise, notes: { merchantRefundId: input.refundId } }),
  });
  if (typeof result.id !== "string" || !result.id) throw new ApiError("The payment provider returned no refund id.", 502);
  return { mode: "razorpay", reference: result.id, notice: "Refund initiated by the provider." };
}

export { checkoutSignature };
