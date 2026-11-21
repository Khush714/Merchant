"use client";
/** Owner-only browser flow for unpaired outlets: creates a local attempt, then verifies/captures it. */

import { useState, type FormEvent } from "react";
import { CreditCard, Loader2 } from "lucide-react";
import { api, Modal } from "@/components/dialogs";
import { money, type Order } from "@/lib/types";

type CheckoutSession = {
  mode: "razorpay" | "dev" | "unavailable";
  attemptId: string;
  providerOrderId: string;
  keyId: string;
  amountPaise: number;
  currency: "INR";
  notice: string;
};
type VerifyInput = {
  attemptId: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
  devReference: string;
};
type VerifyResult = {
  verified: boolean;
  attemptId: string;
  alreadyConfirmed?: boolean;
  mode?: string;
  notice?: string;
};
type RazorpayHandler = (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void;
type RazorpayCtor = new (options: {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: RazorpayHandler;
  modal: { ondismiss: () => void };
}) => { open: () => void };

type CheckoutWindow = Window & { Razorpay?: RazorpayCtor };
let checkoutScript: Promise<RazorpayCtor> | null = null;

function loadRazorpay(): Promise<RazorpayCtor> {
  const browser = window as CheckoutWindow;
  if (browser.Razorpay) return Promise.resolve(browser.Razorpay);
  if (!checkoutScript) {
    checkoutScript = new Promise<RazorpayCtor>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => {
        const loaded = (window as CheckoutWindow).Razorpay;
        if (loaded) resolve(loaded);
        else { checkoutScript = null; reject(new Error("The payment script did not initialise.")); }
      };
      script.onerror = () => { checkoutScript = null; reject(new Error("Could not load the payment checkout script.")); };
      document.head.appendChild(script);
    });
  }
  return checkoutScript;
}

export function PaymentCheckoutModal({ initialOrderId, orders, onClose, onChanged, notify }: {
  initialOrderId: string;
  orders: Order[];
  onClose: () => void;
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const candidates = orders.filter((order) =>
    !["cancelled", "rejected", "completed"].includes(order.status) && order.paymentStatus !== "paid");
  const [orderId, setOrderId] = useState(initialOrderId || candidates[0]?.id || "");
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [devReference, setDevReference] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = candidates.find((order) => order.id === orderId);

  async function verify(input: VerifyInput) {
    setBusy(true);
    setError("");
    try {
      const result = await api<VerifyResult>("/api/merchant/payments/verify", {
        method: "POST", body: JSON.stringify(input),
      });
      notify(result.notice || (result.alreadyConfirmed ? "Payment was already confirmed." : "Payment captured and confirmed."));
      onChanged();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not verify this payment.";
      setError(message);
      notify(message);
    } finally { setBusy(false); }
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<CheckoutSession>("/api/merchant/payments/checkout", {
        method: "POST", body: JSON.stringify({ orderId: selected.id }),
      });
      setSession(created);
      if (created.mode === "razorpay") {
        const Razorpay = await loadRazorpay();
        new Razorpay({
          key: created.keyId,
          amount: created.amountPaise,
          currency: created.currency,
          name: "Savour Merchant",
          description: `Order #${selected.orderNumber}`,
          order_id: created.providerOrderId,
          handler: (response) => void verify({
            attemptId: created.attemptId,
            providerOrderId: response.razorpay_order_id || created.providerOrderId,
            providerPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
            devReference: "",
          }),
          modal: { ondismiss: () => setSession(null) },
        }).open();
      } else {
        notify(created.notice);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not start checkout.";
      setError(message);
      notify(message);
    } finally { setBusy(false); }
  }

  function confirmDev(event: FormEvent) {
    event.preventDefault();
    if (!session || !devReference.trim() || busy) return;
    void verify({
      attemptId: session.attemptId,
      providerOrderId: session.providerOrderId,
      providerPaymentId: devReference.trim(),
      signature: "",
      devReference: devReference.trim(),
    });
  }

  return <Modal title="Collect a payment" subtitle="Only unpaired outlets use this flow. Marketplace owns connected outlets." onClose={onClose}>
    <form className="form-stack" onSubmit={start}>
      {!candidates.length ? <p className="info-box">No open local orders need a payment right now.</p> : <>
        <label>Order<select value={orderId} onChange={(e) => { setOrderId(e.target.value); setSession(null); setError(""); }}>
          {candidates.map((order) => <option key={order.id} value={order.id}>#{order.orderNumber} · {order.customerName} · {money(order.total)}</option>)}
        </select></label>
        {!session && <button className="btn btn-primary full" type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} /> : <CreditCard size={16} />} {busy ? "Opening checkout…" : "Start online payment"}
        </button>}
      </>}
      {session && <div className="info-box">{session.notice}</div>}
      {error && <p className="form-error">{error}</p>}
    </form>
    {session?.mode === "dev" && <form className="form-stack" onSubmit={confirmDev}>
      <label>Dev reference<input value={devReference} maxLength={128} onChange={(e) => setDevReference(e.target.value)} placeholder="SIMULATED-PAYMENT-1" required /></label>
      <button className="btn btn-primary full" type="submit" disabled={busy || !devReference.trim()}>{busy ? "Confirming…" : "Confirm simulator payment"}</button>
    </form>}
    <p className="info-box">The browser never decides whether money arrived. The server verifies the provider signature and captures before confirming the order.</p>
  </Modal>;
}
