import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A one-to-one link to the canonical Marketplace restaurant. The access token is encrypted at rest. */
export const businessMarketplaceLinks = pgTable("business_marketplace_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().unique().references(() => businesses.id, { onDelete: "cascade" }),
  marketplaceRestaurantId: integer("marketplace_restaurant_id").notNull(),
  marketplaceRestaurantName: text("marketplace_restaurant_name").notNull(),
  marketplaceRestaurantSlug: text("marketplace_restaurant_slug").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  settlementSyncAttemptedAt: timestamp("settlement_sync_attempted_at", { withTimezone: true }),
  settlementsSyncedAt: timestamp("settlements_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  uniqueMarketplaceRestaurant: uniqueIndex("unique_marketplace_restaurant_idx").on(table.marketplaceRestaurantId),
}));

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sessions_user_idx").on(table.userId)]);

/** Hashed, expiring, single-use links for email verification and password reset. Raw tokens are never stored. */
export const accountTokens = pgTable("account_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [index("account_tokens_user_purpose_idx").on(table.userId, table.purpose)]);

/**
 * Append-only security audit trail. Actors, emails, IPs and user agents are stored as hashes so the
 * table can be retained for investigations without becoming a second copy of personal data. No
 * application path updates or deletes these rows; pruning is a separate retention job.
 */
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  event: text("event").notNull(),
  outcome: text("outcome").notNull(),
  requestId: text("request_id"),
  actorUserId: uuid("actor_user_id"),
  actorEmailHash: text("actor_email_hash"),
  businessId: uuid("business_id"),
  ipHash: text("ip_hash"),
  userAgentHash: text("user_agent_hash"),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (table) => [
  index("audit_logs_created_at_idx").on(table.createdAt),
  index("audit_logs_event_created_at_idx").on(table.event, table.createdAt),
]);

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().unique().references(() => users.id),
  type: text("type").notNull().default("restaurant"),
  name: text("name").notNull().default(""),
  ownerName: text("owner_name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  category: text("category").notNull().default(""),
  registrationDetails: text("registration_details").notNull().default(""),
  approvalStatus: text("approval_status").notNull().default("draft"),
  isOpen: boolean("is_open").notNull().default(false),
  pickupEnabled: boolean("pickup_enabled").notNull().default(true),
  deliveryEnabled: boolean("delivery_enabled").notNull().default(false),
  hoursEnabled: boolean("hours_enabled").notNull().default(false),
  opensAt: text("opens_at").notNull().default("09:00"),
  closesAt: text("closes_at").notNull().default("22:00"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("businesses_public_idx").on(table.approvalStatus, table.isOpen)]);

/** Non-owner team members. Removal is a soft delete so history and re-invites stay simple. */
export const staffMembers = pgTable("staff_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("server"),
  status: text("status").notNull().default("active"),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("staff_business_user_idx").on(table.businessId, table.userId),
  index("staff_user_idx").on(table.userId),
]);

export const menuItems = pgTable("menu_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: integer("price").notNull(),
  category: text("category").notNull().default("Other"),
  imageUrl: text("image_url").notNull().default(""),
  dietary: text("dietary").notNull().default("unspecified"),
  available: boolean("available").notNull().default(true),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("menu_business_idx").on(table.businessId, table.archived)]);

/** Merchant-created promotions. Paired listings keep offers in Marketplace; these rows stay local. */
export const offers = pgTable("offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  discountType: text("discount_type").notNull(),
  value: integer("value").notNull(),
  minOrder: integer("min_order").notNull().default(0),
  maxDiscount: integer("max_discount"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  usageLimit: integer("usage_limit"),
  active: boolean("active").notNull().default(true),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("offers_business_code_idx").on(table.businessId, table.code),
  index("offers_business_active_idx").on(table.businessId, table.active, table.archived),
]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderNumber: serial("order_number").notNull().unique(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  customerName: text("customer_name").notNull().default("Guest"),
  customerNote: text("customer_note").notNull().default(""),
  total: integer("total").notNull(),
  offerId: uuid("offer_id").references(() => offers.id),
  offerCode: text("offer_code").notNull().default(""),
  discount: integer("discount").notNull().default(0),
  status: text("status").notNull().default("new"),
  fulfilment: text("fulfilment").notNull().default("pickup"),
  deliveryAddress: text("delivery_address").notNull().default(""),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentMethod: text("payment_method").notNull().default("cash"),
  /** Provider-sourced state from signed courier/payment webhooks; blank until an event arrives. */
  courierStatus: text("courier_status").notNull().default(""),
  courierTrackingId: text("courier_tracking_id").notNull().default(""),
  courierUpdatedAt: timestamp("courier_updated_at", { withTimezone: true }),
  paymentReference: text("payment_reference").notNull().default(""),
  paymentUpdatedAt: timestamp("payment_updated_at", { withTimezone: true }),
  prepMinutes: integer("prep_minutes"),
  rejectionReason: text("rejection_reason").notNull().default(""),
  /** Customer feedback comes from the first-party marketplace; paired listings keep it in Marketplace. */
  rating: integer("rating"),
  review: text("review").notNull().default(""),
  feedbackAt: timestamp("feedback_at", { withTimezone: true }),
  merchantResponse: text("merchant_response").notNull().default(""),
  merchantRespondedAt: timestamp("merchant_responded_at", { withTimezone: true }),
  idempotencyHash: text("idempotency_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  commission: integer("commission"),
  refund: integer("refund"),
  adjustment: integer("adjustment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("orders_business_status_idx").on(table.businessId, table.status, table.createdAt),
  index("orders_business_feedback_idx").on(table.businessId, table.feedbackAt),
  uniqueIndex("orders_business_idempotency_idx").on(table.businessId, table.idempotencyHash),
]);

export const orderItems = pgTable("order_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  menuItemId: uuid("menu_item_id").references(() => menuItems.id),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
});

export const orderEvents = pgTable("order_events", {
  id: serial("id").primaryKey(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  actorId: uuid("actor_id").references(() => users.id),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("order_events_order_idx").on(table.orderId)]);

/** Durable, idempotent log of signed courier/payment events. Event ids dedupe provider retries. */
export const providerEvents = pgTable("provider_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull().default("applied"),
  reason: text("reason").notNull().default(""),
  payloadHash: text("payload_hash").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_events_provider_event_idx").on(table.provider, table.eventId),
  index("provider_events_business_idx").on(table.businessId, table.createdAt),
  index("provider_events_order_idx").on(table.orderId),
]);

/**
 * Authoritative net-payout records mirrored from Marketplace. One row represents one completed order;
 * `amount` is the net paise actually deposited (or scheduled for deposit). Re-syncing replaces a row only
 * when Marketplace supplies a newer `sourceUpdatedAt`, so retries and replays cannot duplicate or roll back money.
 */
export const settlements = pgTable("settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  netAmount: integer("amount").notNull(),
  externalId: text("external_id").notNull().default(""),
  marketplaceOrderId: text("marketplace_order_id").notNull().default(""),
  orderNumber: integer("order_number"),
  grossAmount: integer("gross_amount").notNull().default(0),
  commissionAmount: integer("commission_amount").notNull().default(0),
  refundAmount: integer("refund_amount").notNull().default(0),
  adjustmentAmount: integer("adjustment_amount").notNull().default(0),
  currency: text("currency").notNull().default("INR"),
  status: text("status").notNull(),
  reference: text("reference").notNull().default(""),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("settlements_business_idx").on(table.businessId, table.createdAt),
  uniqueIndex("settlements_business_external_idx").on(table.businessId, table.externalId),
  uniqueIndex("settlements_business_order_idx").on(table.businessId, table.marketplaceOrderId),
]);

