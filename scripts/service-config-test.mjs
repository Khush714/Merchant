import assert from "node:assert/strict";
import {
  activeDayPart,
  defaultWeeklyHours,
  distanceMeters,
  indiaNow,
  isWithinBusinessHours,
  menuForDayPart,
  optionalDayParts,
  optionalDeliveryZones,
  optionalWeeklyHours,
  parseDayParts,
  parseDeliveryPoint,
  parseDeliveryZones,
  parseServiceLocation,
  parseWeeklyHours,
  withinServiceArea,
} from "../src/lib/service-config.ts";

// Asia/Kolkata: 2026-11-19 is a Thursday, 10:00 at 04:30 UTC.
const thursday = new Date("2026-11-19T04:30:00.000Z");
assert.deepEqual(indiaNow(thursday), { day: 4, time: "10:00" });

const legacy = { hoursEnabled: true, opensAt: "09:00", closesAt: "14:00", weeklyHours: [] };
assert.equal(isWithinBusinessHours(legacy, thursday), true);
assert.equal(isWithinBusinessHours({ ...legacy, opensAt: "22:00", closesAt: "02:00" }, new Date("2026-11-19T17:30:00.000Z")), true);
assert.equal(isWithinBusinessHours({ ...legacy, opensAt: "22:00", closesAt: "02:00" }, new Date("2026-11-19T21:30:00.000Z")), false);
assert.equal(isWithinBusinessHours({ ...legacy, hoursEnabled: false }, thursday), true);

const weekly = defaultWeeklyHours(legacy).map((entry) => entry.day === 4
  ? { ...entry, enabled: true, opensAt: "09:00", closesAt: "11:00" }
  : { ...entry, enabled: false });
assert.equal(isWithinBusinessHours({ ...legacy, weeklyHours: weekly }, thursday), true);
assert.equal(isWithinBusinessHours({ ...legacy, weeklyHours: weekly }, new Date("2026-11-19T06:30:00.000Z")), false);
assert.equal(isWithinBusinessHours({ ...legacy, weeklyHours: weekly.slice(1) }, thursday), true, "incomplete weeks keep the legacy window");
assert.equal(isWithinBusinessHours({ ...legacy, weeklyHours: weekly.map((entry) => ({ ...entry, enabled: false })) }, thursday), true, "a week with every day off stays open");
assert.throws(() => parseWeeklyHours(weekly.slice(1)));
assert.throws(() => parseWeeklyHours(weekly.map((entry) => entry.day === 4 ? { ...entry, opensAt: "11:00" } : entry)));

const id = "9f2f1f2e-9c33-4e4c-9f27-d1f01b6d4dab";
const part = {
  id, name: "Lunch", opensAt: "11:00", closesAt: "15:00", days: [4], itemIds: ["item-b"], active: true,
};
assert.equal(activeDayPart({ dayParts: [part] }, thursday), null);
const lunchtime = new Date("2026-11-19T06:30:00.000Z"); // 12:00 IST
assert.equal(activeDayPart({ dayParts: [part] }, lunchtime)?.name, "Lunch");
assert.equal(activeDayPart({ dayParts: [{ ...part, days: [5] }] }, lunchtime), null);
const items = [{ id: "item-a" }, { id: "item-b" }];
assert.equal(menuForDayPart(items, { dayParts: [part] }, lunchtime).items.length, 1);
assert.equal(menuForDayPart(items, { dayParts: [] }, lunchtime).items.length, 2);
assert.equal(menuForDayPart(items, { dayParts: [{ ...part, itemIds: [] }] }, lunchtime).items.length, 2);
assert.deepEqual(parseDayParts([part])[0].days, [4]);
assert.throws(() => parseDayParts([{ ...part, opensAt: "15:00", closesAt: "15:00" }]));
assert.throws(() => parseDayParts([part, part]));
assert.equal(optionalDayParts([{ ...part, opensAt: "bad" }]), undefined);

const location = parseServiceLocation({ latitude: 12.9716, longitude: 77.5946, deliveryRadiusMeters: 3000 });
assert.equal(location.latitude, 12.9716);
assert.deepEqual(parseServiceLocation({ latitude: null, longitude: null, deliveryRadiusMeters: 3000 }), { latitude: null, longitude: null, deliveryRadiusMeters: 3000 });
assert.throws(() => parseServiceLocation({ latitude: 91, longitude: 0, deliveryRadiusMeters: 3000 }));
assert.throws(() => parseServiceLocation({ latitude: 0, longitude: 0, deliveryRadiusMeters: 50 }));
const zoneId = "22222222-2222-4222-8222-222222222222";
const zones = parseDeliveryZones([{ id: zoneId, name: "North", latitude: 13.2, longitude: 77.6, radiusMeters: 2000 }]);
assert.equal(zones[0].name, "North");
assert.throws(() => parseDeliveryZones([{ ...zones[0], radiusMeters: 99 }]));
assert.equal(optionalDeliveryZones([{ id: "not-a-uuid", name: "x", latitude: 0, longitude: 0, radiusMeters: 1000 }]), undefined);
assert.equal(optionalWeeklyHours({ nope: true }), undefined);

const center = { latitude: 12.9716, longitude: 77.5946 };
const near = { latitude: 12.98, longitude: 77.5946 };
const far = { latitude: 13.2, longitude: 77.5946 };
assert.ok(distanceMeters(center, near) < 2000);
assert.ok(distanceMeters(center, far) > 20_000);
assert.equal(withinServiceArea(near, { ...location, deliveryZones: [] }).allowed, true);
assert.equal(withinServiceArea(far, { ...location, deliveryZones: [] }).allowed, false);
assert.equal(withinServiceArea(far, { ...location, deliveryZones: zones }).allowed, true);
assert.equal(withinServiceArea(far, { deliveryZones: zones }).zone, "North");
assert.equal(withinServiceArea(null, { deliveryZones: [] }).allowed, true, "address-only customers keep the existing flow");
assert.equal(withinServiceArea(far, { deliveryZones: [] }).allowed, true, "an outlet without a configured area has no boundary to enforce");

assert.deepEqual(parseDeliveryPoint({ deliveryLatitude: 12.98, deliveryLongitude: 77.59 }), { latitude: 12.98, longitude: 77.59 });
assert.deepEqual(parseDeliveryPoint({ deliveryLocation: { latitude: 12.98, longitude: 77.59 } }), { latitude: 12.98, longitude: 77.59 });
assert.equal(parseDeliveryPoint({ note: "no pin" }), null);
assert.throws(() => parseDeliveryPoint({ deliveryLatitude: 100, deliveryLongitude: 0 }));

console.log("PASS: map location, delivery zones, weekly hours and day parts");
