"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/dialogs";

function VerifyEmailForm() {
  const params = useSearchParams();
  const started = useRef(false);
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("");
  useEffect(() => {
    // React may run effects twice in development, but a token is single use.
    if (started.current) return;
    started.current = true;
    let active = true;
    api<{ ok: boolean }>("/api/auth", { method: "POST", body: JSON.stringify({ action: "verify-email", token: params.get("token") ?? "" }) })
      .then(() => { if (active) setState("done"); })
      .catch((error) => { if (active) { setState("error"); setMessage(error instanceof Error ? error.message : "Please try again."); } });
    return () => { active = false; };
  }, [params]);
  return <main className="account-page"><section className="account-card">
    <h1>{state === "working" ? "Verifying your email" : state === "done" ? "Email verified" : "Link unavailable"}</h1>
    <p>{state === "working" ? "Checking the link we sent you." : state === "done" ? "Your email address is confirmed. You can return to your workspace." : message}</p>
    {state === "error" && <p className="dialog-copy">Ask for a fresh link from the verification banner in your workspace.</p>}
    {state !== "working" && <Link className="btn btn-primary full large" href="/">Go to workspace</Link>}
  </section></main>;
}

export default function Page() {
  return <Suspense fallback={<main className="account-page"><section className="account-card"><h1>Verify email</h1><p>Checking your link…</p></section></main>}><VerifyEmailForm /></Suspense>;
}
