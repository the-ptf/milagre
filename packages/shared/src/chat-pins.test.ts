import assert from "node:assert/strict";
import test from "node:test";
import { keepsOnPin, parseDevicePins, scopePins, sessionsWithPins, setPin, withPin } from "./chat-pins.ts";

const sessions = [{ id: 1, pinned: true, pin_order: 2 }, { id: 2 }, { id: 3, pinned: true }];

test("a scope this device never pinned in shows the pins its Chats carry", () => {
  assert.deepEqual(scopePins({}, "/p", sessions), { 1: 2, 3: 0 });
  assert.deepEqual(scopePins({}, "/p", [{ id: 2 }]), {});
});

test("this device's own pins replace the shared ones, even when it has none left", () => {
  assert.deepEqual(scopePins({ "/p": { 2: 0 } }, "/p", sessions), { 2: 0 });
  assert.deepEqual(scopePins({ "/p": {} }, "/p", sessions), {});
  assert.deepEqual(scopePins({ "/q": {} }, "/p", sessions), { 1: 2, 3: 0 });
});

test("the first pin copies the shared pins, then only this device's changes count", () => {
  const once = setPin({}, "/p", sessions, 2, 5);
  assert.deepEqual(once, { "/p": { 1: 2, 3: 0, 2: 5 } });
  const twice = setPin(once, "/p", sessions, 1, null);
  assert.deepEqual(twice, { "/p": { 3: 0, 2: 5 } });
  // The Chats still say 1 is pinned; this device no longer does.
  assert.deepEqual(scopePins(twice, "/p", sessions), { 3: 0, 2: 5 });
});

test("pins of Chats that are gone drop out on the next change", () => {
  assert.deepEqual(setPin({ "/p": { 9: 0, 1: 1 } }, "/p", sessions, 2, 3), { "/p": { 1: 1, 2: 3 } });
});

test("a session takes this device's pin, keeping its identity when nothing changes", () => {
  const session = { id: 1, pinned: true, pin_order: 2 };
  assert.equal(withPin(session, { 1: 2 }), session);
  assert.deepEqual(withPin(session, {}), { id: 1, pinned: false, pin_order: undefined });
  assert.deepEqual(withPin({ id: 2 }, { 2: 4 }), { id: 2, pinned: true, pin_order: 4 });
  const unpinned = { id: 2 };
  assert.equal(withPin(unpinned, { 1: 0 }), unpinned);
});

test("saved pins keep only numeric ids with finite orders", () => {
  assert.deepEqual(parseDevicePins({ "/p": { 1: 2, x: 1, 3: "a", 4: null }, "/q": [], "/r": {} }), { "/p": { 1: 2 }, "/r": {} });
  assert.deepEqual(parseDevicePins(null), {});
  assert.deepEqual(parseDevicePins([1]), {});
});

test("a scope's sessions take this device's pins, the same object when none differ", () => {
  const byId = { 1: { id: 1, pinned: true, pin_order: 2 }, 2: { id: 2 } };
  assert.equal(sessionsWithPins(byId, "/p", {}), byId);
  const mine = sessionsWithPins(byId, "/p", { "/p": { 2: 0 } });
  assert.deepEqual(mine, { 1: { id: 1, pinned: false, pin_order: undefined }, 2: { id: 2, pinned: true, pin_order: 0 } });
  assert.equal(byId[1].pinned, true);
});

test("only a Run Chat its host may still hide is kept on a pin", () => {
  assert.equal(keepsOnPin({ routine: { hidden: true } }), true);
  assert.equal(keepsOnPin({ routine: {} }), true, "saved before Run Chats could be hidden");
  assert.equal(keepsOnPin({ routine: { hidden: false } }), false);
  assert.equal(keepsOnPin({}), false);
  assert.equal(keepsOnPin(undefined), false);
});
