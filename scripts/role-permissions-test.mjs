import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { can, permissionsFor } from "../src/lib/roles.ts";

// Servers really can flip availability, but cannot edit prices or archive dishes.
assert.equal(can("server", "menu.availability"), true);
assert.equal(can("server", "menu.write"), false);
assert.equal(can("kitchen", "menu.availability"), false);
assert.equal(can("manager", "menu.write"), true);
assert.equal(can("owner", "menu.write"), true);
assert.ok(permissionsFor("server").includes("menu.read"));

// Compliance documents are owner-write, manager-read, and invisible to kitchen/server.
assert.equal(can("owner", "compliance.write"), true);
assert.equal(can("owner", "compliance.read"), true);
assert.equal(can("manager", "compliance.read"), true);
assert.equal(can("manager", "compliance.write"), false);
assert.equal(can("kitchen", "compliance.read"), false);
assert.equal(can("server", "compliance.read"), false);

// The API must ask for that finer permission only on availability requests.
const route = readFileSync(new URL("../src/app/api/merchant/menu/route.ts", import.meta.url), "utf8");
assert.match(route, /body\.action === "availability" \? "menu\.availability" : "menu\.write"/);

const ui = readFileSync(new URL("../src/components/merchant-app.tsx", import.meta.url), "utf8");
assert.match(ui, /can\(role, "menu\.availability"\)/);
assert.match(ui, /can\(role, "menu\.write"\)/);

// The Compliance tab is read-visible to managers, while every write action stays owner-only.
assert.match(ui, /id: "compliance", label: "Compliance", icon: ShieldCheck, permission: "compliance\.read"/);
const complianceUi = readFileSync(new URL("../src/components/compliance.tsx", import.meta.url), "utf8");
assert.match(complianceUi, /can\(role, "compliance\.write"\)/);

console.log("PASS: server availability permission matches the API and UI");
