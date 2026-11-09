const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createKeepAwakeSettings } = require("./keep-awake-settings.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-keep-awake-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "keep-awake.json");
  const events = [];
  const settings = createKeepAwakeSettings({ file, emit: (channel, payload) => events.push([channel, payload]) });
  return { file, events, settings };
}

test("keep awake starts off, saves a choice and tells every view", (t) => {
  const { file, events, settings } = setup(t);
  assert.deepEqual(settings.read(), { enabled: false });
  assert.deepEqual(settings.save({ enabled: true }), { enabled: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { enabled: true });
  assert.deepEqual(settings.read(), { enabled: true });
  assert.deepEqual(events, [["keep-awake:settings", { enabled: true }]]);
  assert.deepEqual(settings.save({ enabled: "yes" }), { enabled: false }, "anything but true is off");
  assert.throws(() => settings.save(null), /object/);
});

test("a damaged file reads as off", (t) => {
  const { file, settings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.deepEqual(settings.read(), { enabled: false });
});
