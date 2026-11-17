"use client";
import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/dialogs";

function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [error, setError] = useState(""), [done, setDone] = useState(false), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      await api<{ ok: boolean }>("/api/auth", { method: "POST", body: JSON.stringify({ action: "reset-password", token, password }) });
      setDone(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="account-page"><section className="account-card">
    <h1>{done ? "Password updated" : "Choose a new password"}</h1>
    {done ? <><p>Your password has been changed and other devices have been signed out.</p><Link className="btn btn-primary full large" href="/">Go to workspace</Link></> : <form onSubmit={submit} className="form-stack">
      <p className="dialog-copy">Enter a new password for your Savour Partner account. This link expires in 30 minutes and can only be used once.</p>
      <label>New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      {!token && <p className="form-error">This reset link is missing its token.</p>}
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary full large" disabled={busy || !token}>{busy ? "Updating…" : "Set new password"}</button>
    </form>}
  </section></main>;
}

export default function Page() {
  return <Suspense fallback={<main className="account-page"><section className="account-card"><h1>Reset password</h1><p>Loading…</p></section></main>}><ResetPasswordForm /></Suspense>;
}
