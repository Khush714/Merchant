"use client";

import { useEffect } from "react";

// This replaces the root layout, so it owns its document and styles instead of using globals.css.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error("Merchant global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#f7f8f6", color: "#25312f", fontFamily: "Arial, sans-serif" }}>
        <title>Something went wrong | Savour Partner</title>
        <main role="alert" style={{ maxWidth: 420, padding: 28, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, marginBottom: 10 }}>Savour Partner is unavailable</h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#8a9591", marginBottom: 20 }}>
            An unexpected error stopped this page from loading. Your data is safe; please try again.
          </p>
          <button type="button" onClick={retry} style={{ border: 0, borderRadius: 7, background: "#d95850", color: "#fff", padding: "11px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
