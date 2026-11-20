import assert from "node:assert/strict";
import { isLoopbackUrl, resolveStorageSignedUrl } from "../src/lib/urls.ts";

assert.equal(isLoopbackUrl(new URL("http://localhost:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://127.0.0.1:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://[::1]:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://marketplace.localhost:3001")), true);
assert.equal(isLoopbackUrl(new URL("https://marketplace.example.com")), false);
assert.equal(isLoopbackUrl(new URL("http://marketplace.example.com")), false);
assert.equal(isLoopbackUrl(new URL("http://localhost.example.com")), false);

const signed = resolveStorageSignedUrl(
  "/object/sign/merchant-compliance/business%2Fkind%2Fkey.pdf?token=abc%2Bdef",
  "https://example.supabase.co/",
);
assert.equal(signed.href, "https://example.supabase.co/storage/v1/object/sign/merchant-compliance/business%2Fkind%2Fkey.pdf?token=abc%2Bdef");
assert.equal(
  resolveStorageSignedUrl("object/sign/merchant-compliance/key.pdf?token=x", "https://example.supabase.co").href,
  "https://example.supabase.co/storage/v1/object/sign/merchant-compliance/key.pdf?token=x",
);
assert.equal(
  resolveStorageSignedUrl("/storage/v1/object/sign/merchant-compliance/key.pdf?token=x", "https://example.supabase.co").href,
  "https://example.supabase.co/storage/v1/object/sign/merchant-compliance/key.pdf?token=x",
);
assert.equal(
  resolveStorageSignedUrl("https://cdn.example.com/signed.pdf?token=x", "https://example.supabase.co").href,
  "https://cdn.example.com/signed.pdf?token=x",
);
console.log("PASS: loopback URL detection and Supabase signed URL resolution");
