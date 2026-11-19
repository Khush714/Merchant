import assert from "node:assert/strict";
import { parseRemoteMenuItems, parseRemoteMenuModifierGroupResponse, parseRemoteMenuModifierGroups } from "../src/lib/marketplace-payload.ts";

const item = {
  id: "42", businessId: "biz", name: "Bowl", description: "", price: 30_000,
  category: "Mains", imageUrl: "", dietary: "veg", available: true, archived: false,
  stockQuantity: 12, modifierGroupIds: [7, 8], posSynced: false,
};
const [parsed] = parseRemoteMenuItems({ items: [item] }, "biz");
assert.equal(parsed.stockQuantity, 12);
assert.deepEqual(parsed.modifierGroupIds, ["7", "8"]);
assert.equal(parsed.posSynced, false);
assert.equal(parseRemoteMenuItems({ items: [{ ...item, stockQuantity: null }] }, "biz")[0].stockQuantity, null);
assert.throws(() => parseRemoteMenuItems({ items: [{ ...item, stockQuantity: -1 }] }, "biz"), /stockQuantity/);
assert.throws(() => parseRemoteMenuItems({ items: [{ ...item, stockQuantity: 1.5 }] }, "biz"), /stockQuantity/);

const group = {
  id: 7, name: "Size", minSelect: 1, maxSelect: 1, isActive: true, posSynced: false, itemCount: 2,
  options: [
    { id: 70, name: "Regular", priceCents: 0, isVeg: true, available: true, posSynced: false },
    { id: 71, name: "Large", priceCents: 6000, isVeg: true, available: true, posSynced: false },
  ],
};
assert.deepEqual(parseRemoteMenuModifierGroups({ modifierGroups: [group] }), [{
  id: "7", name: "Size", minSelect: 1, maxSelect: 1, isActive: true, posSynced: false, itemCount: 2,
  options: group.options.map((option) => ({ ...option, id: String(option.id) })),
}]);
assert.equal(parseRemoteMenuModifierGroupResponse({ group }).id, "7");
assert.deepEqual(parseRemoteMenuModifierGroups({}), []);
assert.throws(() => parseRemoteMenuModifierGroups({ modifierGroups: [{ ...group, maxSelect: 0 }] }), /maxSelect/);
assert.throws(() => parseRemoteMenuModifierGroups({ modifierGroups: [{ ...group, options: [{ ...group.options[0], priceCents: 60.5 }] }] }), /priceCents/);
