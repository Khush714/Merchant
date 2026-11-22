-- migrate:no-transaction
-- Remaining scans confirmed with EXPLAIN (ANALYZE, BUFFERS) on a local scratch dataset:
-- orders by business/created_at and settlements by business/status/paid_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_business_created_idx" ON "orders" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "settlements_business_status_paid_idx" ON "settlements" USING btree ("business_id","status","paid_at");
