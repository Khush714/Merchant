ALTER TABLE "orders" ADD COLUMN "delivery_address" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.users, public.sessions, public.businesses, public.menu_items, public.orders, public.order_items, public.order_events, public.settlements FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.orders_order_number_seq FROM anon, authenticated;