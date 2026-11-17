CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text,
	"actor_user_id" uuid,
	"actor_email_hash" text,
	"business_id" uuid,
	"ip_hash" text,
	"user_agent_hash" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_event_created_at_idx" ON "audit_logs" USING btree ("event","created_at");