ALTER TABLE "menu_items" ADD COLUMN "stock_quantity" integer;--> statement-breakpoint
CREATE TABLE "menu_modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "menu_modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL REFERENCES "menu_modifier_groups"("id") ON DELETE cascade,
	"business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"is_veg" boolean DEFAULT true NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"menu_item_id" uuid NOT NULL REFERENCES "menu_items"("id") ON DELETE cascade,
	"modifier_group_id" uuid NOT NULL REFERENCES "menu_modifier_groups"("id") ON DELETE cascade,
	"business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE cascade,
	CONSTRAINT "menu_item_modifier_groups_menu_item_id_modifier_group_id_pk" PRIMARY KEY("menu_item_id","modifier_group_id")
);--> statement-breakpoint
CREATE INDEX "menu_mod_groups_business_idx" ON "menu_modifier_groups" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "menu_mod_options_group_idx" ON "menu_modifier_options" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "menu_item_mod_groups_business_idx" ON "menu_item_modifier_groups" USING btree ("business_id");
