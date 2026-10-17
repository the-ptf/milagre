const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHookStore, HOOK_DELIVERY_MAX_AGE_MS } = require("./hook-store.cjs");

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "data", "routine-hooks.json");
}
const delivery = (id, extra = {}) => ({
  id,
  hookId: "a".repeat(64),
  receivedAt: 1000,
  headers: { "content-type": "application/json" },
  query: { q: "1" },
  body: new Uint8Array([123, 34, 97, 34, 58, 49, 125, 0, 255]),
  ...extra,
});

test("the file is private (0600) and secrets survive a new store on the same file", (t) => {
  const file = tempFile(t);
  const store = createHookStore({ file });
  assert.equal(store.secretFor("r1"), null);
  store.setSecret("r1", { secret: "s".repeat(43), signingSecret: "shh" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const again = createHookStore({ file });
  assert.deepEqual(again.secretFor("r1"), { secret: "s".repeat(43), signingSecret: "shh" });
  again.removeSecret("r1");
  assert.equal(createHookStore({ file }).secretFor("r1"), null);
});

test("a delivery survives re-creation with its body bytes intact, and take removes it", (t) => {
  const file = tempFile(t);
  const store = createHookStore({ file, now: () => 2000 });
  store.putDelivery(delivery("d1"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createHookStore({ file, now: () => 2000 });
  assert.deepEqual(
    again.listDeliveries().map((item) => item.id),
    ["d1"],
  );
  const got = again.getDelivery("d1");
  assert.deepEqual(new Uint8Array(got.body), delivery("d1").body);
  assert.deepEqual(got.headers, { "content-type": "application/json" });
  assert.deepEqual(got.query, { q: "1" });
  assert.equal(got.hookId, "a".repeat(64));
  assert.deepEqual(new Uint8Array(again.takeDelivery("d1").body), delivery("d1").body);
  assert.equal(again.takeDelivery("d1"), null);
  assert.deepEqual(createHookStore({ file }).listDeliveries(), []);
});

test("a batch of deliveries is one write, and deliveries older than 48 h are dropped on load", (t) => {
  const file = tempFile(t);
  let clock = 1000;
  const store = createHookStore({ file, now: () => clock });
  store.putDeliveries([delivery("old", { receivedAt: 1000 }), delivery("new", { receivedAt: 1000 + HOOK_DELIVERY_MAX_AGE_MS })]);
  clock = 1001 + HOOK_DELIVERY_MAX_AGE_MS;
  assert.deepEqual(
    createHookStore({ file, now: () => clock })
      .listDeliveries()
      .map((item) => item.id),
    ["new"],
  );
});

test("a malformed delivery is refused before anything is written", (t) => {
  const file = tempFile(t);
  const store = createHookStore({ file });
  assert.throws(() => store.putDelivery({ id: "", hookId: "x", receivedAt: 1, headers: {}, query: {}, body: new Uint8Array() }));
  assert.throws(() => store.setSecret("r1", { secret: "" }));
  assert.equal(fs.existsSync(file), false);
});

test("a corrupt file is set aside and the store starts empty", (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, "{", { mode: 0o600 });
  const store = createHookStore({ file });
  assert.equal(store.secretFor("r1"), null);
  assert.ok(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("routine-hooks.json.corrupt-")));
});

test("a write lets go of deliveries past 48 h, without a restart", (t) => {
  const file = tempFile(t);
  let clock = 1000;
  const store = createHookStore({ file, now: () => clock });
  store.putDelivery(delivery("old", { receivedAt: 1000 }));
  clock = 1001 + HOOK_DELIVERY_MAX_AGE_MS;
  store.putDelivery(delivery("new", { receivedAt: clock }));
  assert.deepEqual(
    store.listDeliveries().map((item) => item.id),
    ["new"],
  );
});
