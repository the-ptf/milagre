const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTurnDefaults } = require("./turn-defaults.cjs");

test("turn defaults retain explicit choices and fill only missing or invalid values", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-turn-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "turn-defaults.json");
  const defaults = createTurnDefaults({ file });
  assert.deepEqual(defaults.resolve({}), { replies: "concise", tldrEnabled: true });
  assert.equal(fs.existsSync(file), false, "omitted defaults need no write");
  assert.deepEqual(defaults.resolve({ replies: "normal", tldrEnabled: false }), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(defaults.resolve({}), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(defaults.resolve({ replies: "invalid", tldrEnabled: "true" }), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(defaults.resolve({ replies: "concise" }), { replies: "concise", tldrEnabled: false });
  assert.deepEqual(defaults.resolve({ tldrEnabled: true }), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(createTurnDefaults({ file }).read(), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { replies: "concise", tldrEnabled: true });
  fs.writeFileSync(file, "broken JSON");
  assert.deepEqual(defaults.resolve({}), { replies: "concise", tldrEnabled: true });
});
