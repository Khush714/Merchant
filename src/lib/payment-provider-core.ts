/** Pure gateway configuration and signature rules. Safe to import from tests. */
import { createHmac, timingSafeEqual } from "node:crypto";

export type GatewayMode = "razorpay" | "dev" | "unavailable";
export const RAZORPAY_API = "https://api.razorpay.com/v1";

/**
 * `auto` uses Razorpay whenever both credentials exist, a clearly labelled simulator only in
 * non-production, and refuses to pretend in production. `dev` is never allowed in production.
 */
export function gatewayMode(env: NodeJS.ProcessEnv = process.env): GatewayMode {
  const provider = (env.PAYMENT_PROVIDER ?? "auto").trim().toLowerCase();
  const keyId = (env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET ?? "").trim();
  const production = env.NODE_ENV === "production";
  if (provider === "dev") return production ? "unavailable" : "dev";
  if (provider === "razorpay") return keyId && keySecret ? "razorpay" : "unavailable";
  if (provider !== "auto") return "unavailable";
  if (keyId && keySecret) return "razorpay";
  return production ? "unavailable" : "dev";
}

export function gatewayCredentials(env: NodeJS.ProcessEnv = process.env) {
  const keyId = (env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET ?? "").trim();
  if (!keyId || !keySecret) throw new Error("Razorpay credentials are not configured.");
  return { keyId, keySecret };
}

export function razorpayAuthorization(keyId: string, keySecret: string): string {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

/** Razorpay signs `<orderId>|<paymentId>` with the account secret after checkout. */
export function checkoutSignature(secret: string, razorpayOrderId: string, razorpayPaymentId: string): string {
  return createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
}

export function verifyCheckoutSignature(secret: string, razorpayOrderId: string, razorpayPaymentId: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(checkoutSignature(secret, razorpayOrderId, razorpayPaymentId), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Short, unique receipt ids avoid leaking customer data to a provider. */
export function providerReceipt(businessId: string, orderNumber: number | string, attemptId: string): string {
  const suffix = attemptId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `merchant_${businessId.slice(0, 8)}_${String(orderNumber).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}_${suffix}`.slice(0, 40);
}
