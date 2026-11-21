/**
 * Pure payment state rules shared by the webhook service, the operator APIs and tests.
 * No server-only imports here so the exact same rules run in CI.
 *
 * These states describe a single unpaired/local payment attempt. Paired outlets are
 * Marketplace-owned and never reach this state machine.
 */

export const PAYMENT_STATES = ["unpaid", "created", "authorized", "paid", "failed", "refunded"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const PAYMENT_EVENTS = ["authorized", "paid", "failed", "refunded"] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

export type PaymentTransition =
  | { ok: true; state: PaymentState; unchanged: boolean }
  | { ok: false; reason: string };

/** Which current states an event may legitimately move from. Never allows a money regression. */
const ALLOWED_FROM: Record<PaymentEvent, readonly PaymentState[]> = {
  authorized: ["unpaid", "created", "failed"],
  paid: ["unpaid", "created", "authorized", "failed"],
  failed: ["unpaid", "created", "authorized"],
  refunded: ["paid"],
};

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  unpaid: "Unpaid",
  created: "Awaiting payment",
  authorized: "Authorised",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
};

export function isPaymentEvent(value: unknown): value is PaymentEvent {
  return typeof value === "string" && (PAYMENT_EVENTS as readonly string[]).includes(value);
}

export function isPaymentState(value: unknown): value is PaymentState {
  return typeof value === "string" && (PAYMENT_STATES as readonly string[]).includes(value);
}

/** Resolve an event against the current state. Repeat events are idempotent, not regressions. */
export function nextPaymentState(current: PaymentState, event: PaymentEvent): PaymentTransition {
  const target: PaymentState = event;
  if (current === target) return { ok: true, state: target, unchanged: true };
  if (!ALLOWED_FROM[event].includes(current)) {
    return { ok: false, reason: `Cannot mark a ${current} payment as ${event}.` };
  }
  return { ok: true, state: target, unchanged: false };
}

/** Legacy webhooks carry no amount; when present it must match the order total exactly. */
export function verifyPaymentAmount(eventAmountPaise: number | null, orderTotalPaise: number): { ok: true } | { ok: false; reason: string } {
  if (eventAmountPaise === null) return { ok: true };
  if (!Number.isSafeInteger(eventAmountPaise) || eventAmountPaise < 0) return { ok: false, reason: "Invalid payment amount." };
  if (eventAmountPaise !== orderTotalPaise) return { ok: false, reason: "Payment amount does not match the order total." };
  return { ok: true };
}

/** Provider failure text is display-only; cap it and strip control characters before storage. */
export function normalizeFailure(code: string, message: string): { code: string; message: string } {
  const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return { code: clean(code, 64), message: clean(message, 200) };
}
