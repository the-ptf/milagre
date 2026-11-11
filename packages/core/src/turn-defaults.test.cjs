const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTurnDefaults } = require("./turn-defaults.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-turn-defaults-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "turn-defaults.json");
  return { dir, file, defaults: createTurnDefaults({ file }) };
}

test("resolving replayed options never changes remembered choices", (t) => {
  const { file, defaults } = fixture(t);
  assert.deepEqual(defaults.resolve({}), { replies: "concise", tldrEnabled: true });
  defaults.resolve({ replies: "normal", tldrEnabled: false });
  assert.equal(fs.existsSync(file), false);
  defaults.remember({ replies: "normal", tldrEnabled: false });
  const saved = fs.readFileSync(file, "utf8");
  assert.deepEqual(defaults.resolve({ replies: "concise", tldrEnabled: true }), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(defaults.resolve({}), { replies: "normal", tldrEnabled: false });
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("remember saves only valid explicit choices, preserves omitted fields and survives restart", (t) => {
  const { file, defaults } = fixture(t);
  defaults.remember({ replies: "normal", tldrEnabled: false });
  defaults.remember({ replies: "invalid", tldrEnabled: "true" });
  assert.deepEqual(defaults.read(), { replies: "normal", tldrEnabled: false });
  defaults.remember({ replies: "concise" });
  assert.deepEqual(defaults.read(), { replies: "concise", tldrEnabled: false });
  defaults.remember({ tldrEnabled: true });
  assert.deepEqual(createTurnDefaults({ file }).read(), { replies: "concise", tldrEnabled: true });
  const write = t.mock.method(fs, "writeFileSync", () => {});
  defaults.remember({ replies: "concise", tldrEnabled: true });
  assert.equal(write.mock.calls.length, 0, "unchanged choices need no write");
});

test("defaults are read once and corrupt files fall back to desktop defaults", (t) => {
  const { file, defaults } = fixture(t);
  fs.writeFileSync(file, "broken JSON");
  assert.deepEqual(defaults.read(), { replies: "concise", tldrEnabled: true });
  const read = t.mock.method(fs, "readFileSync", () => assert.fail("cached choices need no read"));
  defaults.resolve({});
  defaults.remember({ replies: "normal" });
  assert.deepEqual(defaults.resolve({}), { replies: "normal", tldrEnabled: true });
  assert.equal(read.mock.calls.length, 0);
});

test("a failed atomic save warns, removes its temporary file and keeps the choice in memory", (t) => {
  const { dir, file, defaults } = fixture(t);
  defaults.remember({ replies: "normal", tldrEnabled: false });
  const saved = fs.readFileSync(file, "utf8");
  const warning = t.mock.method(console, "warn", () => {});
  t.mock.method(fs, "renameSync", () => {
    throw new Error("disk unavailable");
  });
  assert.doesNotThrow(() => defaults.remember({ replies: "concise" }));
  assert.deepEqual(defaults.resolve({}), { replies: "concise", tldrEnabled: false });
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  assert.deepEqual(fs.readdirSync(dir), ["turn-defaults.json"]);
  assert.match(warning.mock.calls[0].arguments.join(" "), /disk unavailable/);
});
