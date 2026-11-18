import assert from "node:assert/strict";
import { isInvalidMarketplaceLinkError, MARKETPLACE_LINK_INVALID } from "../src/lib/marketplace-link-status.ts";

// Only the explicit upstream rejection marks the pairing dead. Everything else
// (network errors, 5xx, session expiry) must leave validity unknown.
assert.equal(isInvalidMarketplaceLinkError({ status: 401, code: MARKETPLACE_LINK_INVALID }), true);
assert.equal(isInvalidMarketplaceLinkError({ status: 401, code: "AUTH_REQUIRED" }), false);
assert.equal(isInvalidMarketplaceLinkError({ status: 502, code: MARKETPLACE_LINK_INVALID }), false);
assert.equal(isInvalidMarketplaceLinkError({ status: 401 }), false);
assert.equal(isInvalidMarketplaceLinkError(null), false);
assert.equal(isInvalidMarketplaceLinkError("401"), false);

console.log("link-status checks passed");
