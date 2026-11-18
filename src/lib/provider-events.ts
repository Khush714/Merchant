/**
 * Pure validation and HMAC helpers for provider-sourced order events. Kept free of server-only
 * imports so the same rules can be exercised directly in tests.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PROVIDER_KINDS = ["courier", "payment"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const COURIER_EVENT_TYPES = ["assigned", "picked_up", "out_for_delivery", "delivered", "failed"] as const;
export const PAYMENT_EVENT_TYPES = ["authorized", "paid", "failed", "refunded"] as const;
export type CourierEventType = (typeof COURIER_EVENT_TYPES)[number];
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];
export type ProviderEventType = CourierEventType | PaymentEventType;

export type ParsedProviderEvent = {
  provider: ProviderKind;
  eventId: string;
  businessId: string;
  orderId: string | null;
  orderCode: number | null;
  type: ProviderEventType;
  occurredAt: string;
  trackingId: string;
  reference: string;
};

export class ProviderEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEventError";
  }
}

function fail(message: string): never { throw new ProviderEventError(message); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ORDER_CODE = /^\d{1,10}$/;

function text(value: unknown, label: string, max: number, pattern?: RegExp) {
  if (typeof value !== "string" || value.length > max) fail(`${label} is invalid.`);
  if (pattern && !pattern.test(value)) fail(`${label} is invalid.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label} contains control characters.`);
  return value;
}

export function parseProviderEvent(provider: ProviderKind, payload: unknown): ParsedProviderEvent {
  if (!PROVIDER_KINDS.includes(provider)) fail("Unknown provider.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("Event payload must be an object.");
  const body = payload as Record<string, unknown>;
  const eventId = text(body.eventId, "eventId", 128, EVENT_ID);
  const businessId = text(body.businessId, "businessId", 36, UUID);
  const orderId = body.orderId === undefined ? null : text(body.orderId, "orderId", 36, UUID);
  const rawCode = body.orderCode === undefined ? null : text(body.orderCode, "orderCode", 10, ORDER_CODE);
  if ((orderId === null) === (rawCode === null)) fail("Supply either orderId or orderCode.");
  const orderCode = rawCode === null ? null : Number(rawCode);
  if (orderCode !== null && (!Number.isSafeInteger(orderCode) || orderCode < 1 || orderCode > 2_147_483_647)) fail("orderCode is invalid.");

  const allowed: readonly string[] = provider === "courier" ? COURIER_EVENT_TYPES : PAYMENT_EVENT_TYPES;
  const type = text(body.type, "type", 32);
  if (!allowed.includes(type)) fail(`Unsupported ${provider} event type.`);
  const occurredAtRaw = text(body.occurredAt, "occurredAt", 40);
  const timestamp = Date.parse(occurredAtRaw);
  if (!Number.isFinite(timestamp)) fail("occurredAt must be an ISO timestamp.");
  const occurredAt = new Date(timestamp).toISOString();
  const trackingId = text(body.trackingId ?? "", "trackingId", 128);
  const reference = text(body.reference ?? "", "reference", 128);
  return { provider, eventId, businessId, orderId, orderCode, type: type as ProviderEventType, occurredAt, trackingId, reference };
}

/** The signed preimage is `<unix seconds>.<raw JSON body>`; no parsed/re-serialized body is used. */
export function providerSignature(secret: string, rawBody: string, timestampSeconds: number) {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

export function signatureHeader(secret: string, rawBody: string, timestampSeconds: number) {
  return `t=${timestampSeconds},v1=${providerSignature(secret, rawBody, timestampSeconds)}`;
}

export function verifyProviderSignature(secret: string, rawBody: string, header: string | null, now = Date.now()) {
  if (!secret || secret.length < 32) fail("Webhook secret is not configured on the Merchant App.");
  const match = /^t=(\d{10}),v1=([a-f0-9]{64})$/.exec(header ?? "");
  if (!match) fail("Webhook signature is missing or malformed.");
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) fail("Webhook timestamp is outside the allowed window.");
  const expected = Buffer.from(providerSignature(secret, rawBody, timestamp), "hex");
  const supplied = Buffer.from(match[2], "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) fail("Webhook signature is invalid.");
}
