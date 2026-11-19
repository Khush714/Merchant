/**
 * Map-based service areas, per-day recurring hours and day-part menus.
 *
 * Everything here is pure and shared by the merchant API, the first-party
 * storefront and the merchant UI. Times are `HH:mm` in Asia/Kolkata and days
 * use JavaScript weekday numbers (0 = Sunday). An empty `weeklyHours` list
 * keeps the legacy single daily window, so existing outlets need no migration
 * of their working schedule.
 */

export type DeliveryZone = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type WeeklyDayHours = {
  day: number;
  enabled: boolean;
  opensAt: string;
  closesAt: string;
};

export type DayPart = {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string;
  /** Empty means every day; otherwise 0 = Sunday … 6 = Saturday. */
  days: number[];
  itemIds: string[];
  active: boolean;
};

export type ServicePoint = { latitude: number; longitude: number };

export const DEFAULT_DELIVERY_RADIUS_METERS = 3_000;
export const MIN_DELIVERY_RADIUS_METERS = 250;
export const MAX_DELIVERY_RADIUS_METERS = 25_000;
const MAX_ZONES = 20;
const MAX_DAY_PARTS = 12;
const MAX_DAY_PART_ITEMS = 200;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

type Row = Record<string, unknown>;

function row(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Row;
}

function cleanText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`Enter a valid ${label}.`);
  const text = value.trim();
  if (!text || CONTROL.test(text)) throw new Error(`Enter a valid ${label}.`);
  return text.slice(0, max);
}

function time(value: unknown, label: string): string {
  if (typeof value !== "string" || !TIME.test(value)) throw new Error(`Enter a valid ${label}.`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Enter a valid ${label}.`);
  return value;
}

function coordinate(value: unknown, label: string, min: number, max: number): number {
  const number = finiteNumber(value, label);
  if (number < min || number > max) throw new Error(`Enter a valid ${label}.`);
  return number;
}

function radius(value: unknown): number {
  const number = finiteNumber(value, "delivery radius");
  if (!Number.isInteger(number) || number < MIN_DELIVERY_RADIUS_METERS || number > MAX_DELIVERY_RADIUS_METERS) {
    throw new Error(`Choose a radius between ${MIN_DELIVERY_RADIUS_METERS / 1000} and ${MAX_DELIVERY_RADIUS_METERS / 1000} km.`);
  }
  return number;
}

function days(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 7) throw new Error("Choose valid days.");
  const result = [...new Set(value.map((entry) => {
    if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 6) throw new Error("Choose valid days.");
    return entry as number;
  }))].sort((a, b) => a - b);
  return result;
}

/** Clearing the pin is allowed; a set pin always has both coordinates. */
export function parseServiceLocation(value: unknown): { latitude: number | null; longitude: number | null; deliveryRadiusMeters: number } {
  const input = row(value, "location");
  if (input.latitude === null && input.longitude === null) {
    return { latitude: null, longitude: null, deliveryRadiusMeters: radius(input.deliveryRadiusMeters ?? DEFAULT_DELIVERY_RADIUS_METERS) };
  }
  return {
    latitude: coordinate(input.latitude, "latitude", -90, 90),
    longitude: coordinate(input.longitude, "longitude", -180, 180),
    deliveryRadiusMeters: radius(input.deliveryRadiusMeters ?? DEFAULT_DELIVERY_RADIUS_METERS),
  };
}

export function parseDeliveryZones(value: unknown): DeliveryZone[] {
  if (!Array.isArray(value) || value.length > MAX_ZONES) throw new Error(`Keep at most ${MAX_ZONES} delivery zones.`);
  const seen = new Set<string>();
  return value.map((entry) => {
    const input = row(entry, "delivery zone");
    const id = cleanText(input.id, "zone id", 64);
    if (!UUID.test(id) || seen.has(id)) throw new Error("Delivery zones need unique ids. Refresh and try again.");
    seen.add(id);
    return {
      id,
      name: cleanText(input.name, "zone name", 60),
      latitude: coordinate(input.latitude, "zone latitude", -90, 90),
      longitude: coordinate(input.longitude, "zone longitude", -180, 180),
      radiusMeters: radius(input.radiusMeters),
    };
  });
}

export function parseWeeklyHours(value: unknown): WeeklyDayHours[] {
  if (!Array.isArray(value) || value.length !== 7) throw new Error("Set hours for all seven days.");
  const result = value.map((entry) => {
    const input = row(entry, "daily hours");
    const day = input.day;
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) throw new Error("Choose valid days.");
    const opensAt = time(input.opensAt, "opening time");
    const closesAt = time(input.closesAt, "closing time");
    if (opensAt === closesAt) throw new Error("Opening and closing times must differ.");
    if (typeof input.enabled !== "boolean") throw new Error("Invalid daily hours.");
    return { day: day as number, enabled: input.enabled, opensAt, closesAt };
  });
  if (new Set(result.map((entry) => entry.day)).size !== 7) throw new Error("Set hours for all seven days.");
  return result.sort((a, b) => a.day - b.day);
}

export function parseDayParts(value: unknown): DayPart[] {
  if (!Array.isArray(value) || value.length > MAX_DAY_PARTS) throw new Error(`Keep at most ${MAX_DAY_PARTS} day parts.`);
  const seen = new Set<string>();
  return value.map((entry) => {
    const input = row(entry, "day part");
    const id = cleanText(input.id, "day part id", 64);
    if (!UUID.test(id) || seen.has(id)) throw new Error("Day parts need unique ids. Refresh and try again.");
    seen.add(id);
    const opensAt = time(input.opensAt, "start time");
    const closesAt = time(input.closesAt, "end time");
    if (opensAt === closesAt) throw new Error("Day part start and end times must differ.");
    if (input.itemIds !== undefined && (!Array.isArray(input.itemIds) || input.itemIds.length > MAX_DAY_PART_ITEMS)) {
      throw new Error(`Choose at most ${MAX_DAY_PART_ITEMS} items for a day part.`);
    }
    const itemIds = ((input.itemIds ?? []) as unknown[]).map((itemId) => cleanText(itemId, "menu item", 128));
    if (new Set(itemIds).size !== itemIds.length) throw new Error("A day part cannot repeat the same item.");
    return {
      id,
      name: cleanText(input.name, "day part name", 40),
      opensAt,
      closesAt,
      days: days(input.days ?? []),
      itemIds,
      active: input.active === undefined ? true : typeof input.active === "boolean" ? input.active : (() => { throw new Error("Invalid day part state."); })(),
    };
  });
}

/** Optional upstream fields: invalid values are ignored so an older Marketplace cannot break a save. */
export function optionalDeliveryZones(value: unknown): DeliveryZone[] | undefined {
  try { return value === undefined || value === null ? undefined : parseDeliveryZones(value); }
  catch { return undefined; }
}
export function optionalWeeklyHours(value: unknown): WeeklyDayHours[] | undefined {
  try { return value === undefined || value === null ? undefined : parseWeeklyHours(value); }
  catch { return undefined; }
}
export function optionalDayParts(value: unknown): DayPart[] | undefined {
  try { return value === undefined || value === null ? undefined : parseDayParts(value); }
  catch { return undefined; }
}

export function indiaNow(now = new Date()): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return { day: day < 0 ? 1 : day, time: `${hour}:${minute}` };
}

export function timeInWindow(current: string, opensAt: string, closesAt: string): boolean {
  return opensAt <= closesAt
    ? current >= opensAt && current < closesAt
    : current >= opensAt || current < closesAt;
}

type HoursBusiness = {
  hoursEnabled: boolean;
  opensAt: string;
  closesAt: string;
  weeklyHours?: WeeklyDayHours[] | null;
};

/** Weekly hours replace the legacy window only when all seven days were configured. */
export function isWithinBusinessHours(business: HoursBusiness, now = new Date()): boolean {
  const { day, time } = indiaNow(now);
  if (Array.isArray(business.weeklyHours) && business.weeklyHours.length === 7) {
    if (!business.weeklyHours.some((entry) => entry.enabled)) return true;
    const today = business.weeklyHours.find((entry) => entry.day === day);
    return Boolean(today?.enabled && timeInWindow(time, today.opensAt, today.closesAt));
  }
  if (!business.hoursEnabled) return true;
  return timeInWindow(time, business.opensAt, business.closesAt);
}

/** The first configured part wins when windows overlap, so customers see one stable menu. */
export function activeDayPart<T extends { dayParts?: DayPart[] | null }>(business: T, now = new Date()): DayPart | null {
  const { day, time } = indiaNow(now);
  const parts = (business.dayParts ?? []).filter((part) => part?.active && (!part.days.length || part.days.includes(day)));
  const match = parts.find((part) => timeInWindow(time, part.opensAt, part.closesAt));
  return match ?? null;
}

/** An active part with no items means "show the full menu"; one with items narrows it. */
export function menuForDayPart<T extends { id: string }>(items: T[], business: { dayParts?: DayPart[] | null }, now = new Date()): { items: T[]; dayPart: DayPart | null } {
  const dayPart = activeDayPart(business, now);
  if (!dayPart || dayPart.itemIds.length === 0) return { items, dayPart };
  const allowed = new Set(dayPart.itemIds);
  return { items: items.filter((item) => allowed.has(item.id)), dayPart };
}

/** Haversine distance in metres; accurate enough for local delivery boundaries. */
export function distanceMeters(from: ServicePoint, to: ServicePoint): number {
  const rad = (value: number) => value * Math.PI / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLng = rad(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type AreaBusiness = {
  latitude?: number | null;
  longitude?: number | null;
  deliveryRadiusMeters?: number | null;
  deliveryZones?: DeliveryZone[] | null;
};

export function withinServiceArea(point: ServicePoint | null, business: AreaBusiness): { allowed: boolean; zone: string | null } {
  // A customer without map coordinates keeps the existing address-only flow.
  if (!point) return { allowed: true, zone: null };
  const center = business.latitude !== null && business.latitude !== undefined && business.longitude !== null && business.longitude !== undefined
    ? { latitude: business.latitude, longitude: business.longitude }
    : null;
  if (center && distanceMeters(center, point) <= (business.deliveryRadiusMeters ?? DEFAULT_DELIVERY_RADIUS_METERS)) {
    return { allowed: true, zone: null };
  }
  const configuredZones = business.deliveryZones ?? [];
  // No pin and no zones means no configured boundary to enforce.
  if (!center && !configuredZones.length) return { allowed: true, zone: null };
  const zone = configuredZones.find((item) => item && distanceMeters({ latitude: item.latitude, longitude: item.longitude }, point) <= item.radiusMeters);
  return zone ? { allowed: true, zone: zone.name } : { allowed: false, zone: null };
}

/** Read optional customer coordinates from a checkout body. */
export function parseDeliveryPoint(value: unknown): ServicePoint | null {
  const input = row(value, "checkout");
  const nested = input.deliveryLocation ? row(input.deliveryLocation, "delivery location") : null;
  const lat = input.deliveryLatitude ?? nested?.latitude;
  const lng = input.deliveryLongitude ?? nested?.longitude;
  if (lat === undefined && lng === undefined) return null;
  if (lat === null && lng === null) return null;
  return { latitude: coordinate(lat, "delivery latitude", -90, 90), longitude: coordinate(lng, "delivery longitude", -180, 180) };
}

/** UI helper that keeps all seven days in a stable Sunday-to-Saturday order. */
export function defaultWeeklyHours(business: HoursBusiness): WeeklyDayHours[] {
  return Array.from({ length: 7 }, (_, day) => ({ day, enabled: business.hoursEnabled, opensAt: business.opensAt, closesAt: business.closesAt }));
}
