const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BABYSIT_DEFAULTS } = require("@milagre/shared/babysit");
const { createBabysitSettings } = require("./babysit-settings.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-babysit-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "babysit.json");
  const events = [];
  const settings = createBabysitSettings({ file, emit: (channel, payload) => events.push([channel, payload]) });
  return { file, events, settings };
}

test("read without a file returns defaults", (t) => {
  const { settings, events } = setup(t);
  assert.deepEqual(settings.read(), BABYSIT_DEFAULTS);
  assert.deepEqual(events, []);
});

test("save merges a patch, persists it and emits once", (t) => {
  const { file, settings, events } = setup(t);
  const value = settings.save({ enabled: true });
  assert.equal(value.enabled, true);
  assert.equal(value.level, 3);
  assert.deepEqual(events, [["babysit:settings", value]]);
  assert.deepEqual(settings.read(), value);
  assert.deepEqual(createBabysitSettings({ file }).read(), value, "survives a reload");
  const next = settings.save({ level: 2 });
  assert.equal(next.enabled, true, "an earlier save is kept");
  assert.equal(next.level, 2);
  assert.equal(events.length, 2);
});

test("save normalizes and refuses a patch that is not an object", (t) => {
  const { settings, events } = setup(t);
  assert.equal(settings.save({ level: 99 }).level, BABYSIT_DEFAULTS.level);
  for (const bad of [null, undefined, "x", 3, [], true]) assert.throws(() => settings.save(bad), /object/);
  assert.equal(events.length, 1, "a refused patch emits nothing");
});

test("a corrupt file reads as defaults", (t) => {
  const { file, settings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.deepEqual(settings.read(), BABYSIT_DEFAULTS);
});
