import Link from "next/link";
import { Info } from "lucide-react";

export default function NotFound() {
  return (
    <main className="content-wrap">
      <div className="empty-state">
        <span><Info size={25} /></span>
        <strong>Page not found</strong>
        <p>That page doesn’t exist or may have moved.</p>
        <Link href="/" className="btn btn-primary">Back to your workspace</Link>
      </div>
    </main>
  );
}
