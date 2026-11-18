import assert from "node:assert/strict";
import { isLoopbackUrl } from "../src/lib/urls.ts";

assert.equal(isLoopbackUrl(new URL("http://localhost:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://127.0.0.1:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://[::1]:3001")), true);
assert.equal(isLoopbackUrl(new URL("http://marketplace.localhost:3001")), true);
assert.equal(isLoopbackUrl(new URL("https://marketplace.example.com")), false);
assert.equal(isLoopbackUrl(new URL("http://marketplace.example.com")), false);
assert.equal(isLoopbackUrl(new URL("http://localhost.example.com")), false);

console.log("PASS: loopback URL detection for local production validation");
