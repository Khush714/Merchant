-- migrate:no-transaction
-- Supabase mirror of drizzle/0024_phase2_query_indexes.sql.
-- CONCURRENTLY keeps writes available; this file must run outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_business_created_idx" ON "orders" USING btree ("business_id","created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "settlements_business_status_paid_idx" ON "settlements" USING btree ("business_id","status","paid_at");
