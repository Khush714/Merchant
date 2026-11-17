"use client";

import { useEffect } from "react";
import { Info } from "lucide-react";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    // The digest on server errors matches this entry in the server logs.
    console.error("Merchant route error:", error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <main className="content-wrap">
      <div className="empty-state" role="alert">
        <span><Info size={25} /></span>
        <strong>We couldn’t load this page.</strong>
        <p>Your data is safe. Try again, or reload the page if the problem continues.</p>
        <button className="btn btn-primary" onClick={retry}>Try again</button>
        {digest && <small className="small-text">Reference: {digest}</small>}
      </div>
    </main>
  );
}
