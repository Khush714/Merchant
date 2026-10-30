# Savour Partner

A mobile-first merchant workspace and a small shared customer marketplace built on the repository's actual Next.js App Router, PostgreSQL and Drizzle starter.

## Repository audit

The supplied repository began as a Merchant-only Next.js/PostgreSQL foundation rather than the described Vite/Express/POS application. Merchant now pairs with the separate Marketplace through an authenticated, business-scoped integration API; it does not share the Marketplace database URL or duplicate its order lifecycle. Marketplace and the connected POS remain authoritative for paired business orders.

## Supabase setup

The app uses Supabase as managed PostgreSQL through the server-side `pg` driver. It does not use Supabase Auth or the browser Data API: app accounts and sessions are managed by the app. Keep the Supabase database password and connection URL private; only set `DATABASE_URL` in the Vercel project's server environment variables. For Vercel, use Supabase's transaction pooler connection string and its required SSL parameters. Never expose a database URL, password, or service-role key to browser code.

Install the Supabase CLI, authenticate with `npx supabase login`, then link the local project with `npx supabase link --project-ref <project-ref>`. Set the database password when the CLI prompts for it; do not put it in source control or chat. Apply schema migrations to the new, empty Supabase database with `npx supabase db push`. The ordered migrations are in `supabase/migrations/`; the earlier `drizzle/` files are retained for existing Drizzle workflows. Tables have row-level security enabled and no Data API policies, and direct `anon`/`authenticated` table access is revoked. The server connects with its private database URL.

For local development, set `DATABASE_URL` to a Supabase PostgreSQL connection string before `npm run dev`. No demo records are inserted into the database. Signed-out visitors see a clearly labeled, non-persistent sample workspace; real accounts use only server data.

For service-to-service approval, configure a long random `MARKETPLACE_ADMIN_TOKEN` on the server and call `POST /api/admin/approval` with `Authorization: Bearer <token>` and `{ "businessId": "...", "status": "approved" | "rejected" }`. Only pending businesses can be reviewed. Approval never opens the store automatically. This is a minimal integration hook, not an administrative review UI or a regulatory verification system.

## API surface

- `GET/POST /api/auth`: account registration, login, logout and session lookup. Passwords use salted scrypt; sessions are opaque, hashed in PostgreSQL and held in an HttpOnly SameSite cookie.
- `GET/POST/PATCH /api/merchant/business`: owner-scoped draft, details, hours and availability. Opening requires approval.
- `GET/POST/PATCH/DELETE /api/merchant/menu`: owner-scoped menu creation, editing, availability and archival.
- `GET/PATCH /api/merchant/orders`: paginated, filterable order history and expected-status transitions. A transaction records each successful change; conflicting updates return 409. Ready is distinct from completion. Merchant handoff completion is supported for pickup only.
- `GET /api/merchant/overview`: server-derived counts, today's completed gross order value and actual settlement records.
- `GET/POST/DELETE /api/merchant/marketplace-link`: read the current Marketplace pairing, redeem a one-time pairing code, or disconnect and revoke the remote token.
- `GET/POST /api/marketplace`: approved/open business listings, available items, token-protected customer tracking and idempotent order creation. Prices are calculated on the server and store status, hours and item availability are rechecked in a transaction. Order creation is refused for paired businesses, which accept orders through Marketplace.
- `POST /api/admin/approval`: server-token-protected review hook.

## Savour Marketplace integration

The Merchant App can be paired with the canonical Savour Marketplace without sharing its PostgreSQL database. In the Marketplace partner console, open **Merchant App**, generate a one-time pairing code, then enter it in **Savour Merchant → Business settings → Marketplace connection**. Codes expire after 10 minutes and can be used once.

When paired, the Merchant App proxies menu edits, store availability/settings, order inbox, status changes, and overview metrics to the Marketplace APIs using a per-business bearer token encrypted at rest. The Marketplace database remains authoritative for the published listing, menu, customer orders, and payment state. The Merchant App does not dual-write Marketplace orders to its own `orders` table; local checkout is blocked for a paired business to prevent duplicate orders. Disconnecting revokes the remote token and removes the encrypted local copy without deleting order history.

Configure `MARKETPLACE_API_URL`, `MERCHANT_APP_INTEGRATION_SECRET`, and `MERCHANT_APP_TOKEN_ENCRYPTION_KEY` using `.env.example`. The integration secret must match on both servers. The encryption key is Merchant-App-only and must be a separate random secret. Run the Merchant App migration that creates `business_marketplace_links` before pairing: `supabase/migrations/20261028000000_marketplace_bridge.sql` (the Drizzle equivalent is `drizzle/0002_marketplace_link.sql`). Do not copy Marketplace's database URL into Merchant; the integration uses authenticated, business-scoped Marketplace integration APIs.

## Operational notes and limitations

- The customer marketplace bundled in Merchant remains a separate first-party surface, not the external Marketplace. Checkout for a paired Marketplace business is refused so it does not receive duplicate orders; its menu and orders are read from Marketplace instead.
- Accounts currently support email/password only. Email verification, password reset, staff roles, MFA and a production identity-provider integration are not implemented. The in-process rate limiter is per-instance and must be replaced with a shared, trusted-proxy-aware limiter for multi-instance production. Harden CSRF, session rotation, monitoring and audit retention for the deployment.
- Notifications use sensible foreground polling and optional browser notifications/sound. They are not push notifications and are not reliable with the page closed or the device offline. Browser permission and sound policies apply. Offline changes are not queued: the UI reports failures and reloads authoritative state on reconnection.
- Only cash/unpaid customer checkout is supported; there is no payment gateway, courier integration, delivery-completion webhook, refund processor or settlement provider. Delivery destinations are collected, but enabling delivery requires the business to arrange fulfilment; delivery orders cannot be marked completed by the merchant until an authoritative integration is added. Net proceeds are intentionally unavailable rather than guessed. Settlement records must be populated by an authoritative integration.
- Business hours are a simple daily schedule in India Standard Time. Map location, per-day schedules, temporary closure expiry, upload storage, add-ons/customisations and a real staff management system require integration work. Menu images accept HTTPS URLs; no file-upload service is configured.
- Public marketplace orders have no customer identity system; a high-entropy order token is kept in browser storage for status lookup and retry. A production customer authentication, privacy and order-recovery design is required.
- Approval requires the server hook above or a trusted administrative process. There is no automatic approval or invented verification result. Currency is INR in paise.
- The initial migration creates new tables only because no pre-existing business/order tables were present; the second adds the delivery-address field; the third (`20261028000000_marketplace_bridge.sql`) replaces the earlier OAuth link columns with `business_marketplace_links`. Review them against any target database before deployment.

## Validation

Run `npm run lint`, `npx next typegen`, `npm exec tsc -- --noEmit --pretty false`, and `npm run build`. The API integration smoke test in `scripts/integration-test.mjs` uses a running local preview and a disposable pair of test accounts; it uses `DATABASE_URL` for test approval/cleanup only and must never be run against a production database.
