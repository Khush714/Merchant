-- An owner may run more than one outlet. Each outlet pairs to its own Marketplace listing.
ALTER TABLE "businesses" DROP CONSTRAINT "businesses_owner_id_unique";--> statement-breakpoint
CREATE INDEX "businesses_owner_idx" ON "businesses" USING btree ("owner_id");--> statement-breakpoint
-- The selected outlet lives on the session so no client-supplied business id is trusted on normal requests.
ALTER TABLE "sessions" ADD COLUMN "active_business_id" uuid REFERENCES "businesses"("id") ON DELETE set null;--> statement-breakpoint
-- Existing accounts had at most one outlet; make that outlet the default for their current sessions.
UPDATE "sessions" SET "active_business_id" = "owner_business"."id"
FROM (SELECT DISTINCT ON ("owner_id") "owner_id", "id" FROM "businesses" ORDER BY "owner_id", "id") AS "owner_business"
WHERE "owner_business"."owner_id" = "sessions"."user_id";
