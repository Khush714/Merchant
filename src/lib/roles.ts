/** Staff access model. Owners are implicit (business.owner_id) and always have every permission. */
export const STAFF_ROLES = ["manager", "kitchen", "server"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type AppRole = "owner" | StaffRole;

export type Permission =
  | "orders.read" | "orders.write"
  | "menu.read" | "menu.write"
  | "offers.read" | "offers.write"
  | "feedback.write"
  | "overview.read"
  | "settings.write"
  | "settlements.read"
  | "staff.write"
  | "integration.write";

export const ALL_PERMISSIONS: readonly Permission[] = [
  "orders.read", "orders.write", "menu.read", "menu.write", "offers.read", "offers.write",
  "feedback.write", "overview.read", "settings.write", "settlements.read", "staff.write", "integration.write",
];

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  // Managers run the outlet but cannot change who has access or rewire the Marketplace integration.
  manager: ["orders.read", "orders.write", "menu.read", "menu.write", "offers.read", "offers.write", "feedback.write", "overview.read", "settings.write", "settlements.read"],
  // Kitchen only works the order queue; it cannot see pricing, promotions or payouts.
  kitchen: ["orders.read", "orders.write", "overview.read"],
  // Servers handle orders and item availability, and respond to customer feedback.
  server: ["orders.read", "orders.write", "menu.read", "overview.read", "feedback.write"],
};

export const ROLE_LABELS: Record<AppRole, string> = { owner: "Owner", manager: "Manager", kitchen: "Kitchen", server: "Server" };
export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  owner: "Full access, including staff and Marketplace integration",
  manager: "Orders, menu, offers, settings and payouts",
  kitchen: "Order queue only",
  server: "Orders, item availability and customer replies",
};

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

export function permissionsFor(role: AppRole): readonly Permission[] {
  return role === "owner" ? ALL_PERMISSIONS : ROLE_PERMISSIONS[role];
}

export function can(role: AppRole, permission: Permission) {
  return permissionsFor(role).includes(permission);
}
