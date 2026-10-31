const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDoneSettings } = require("./done-settings.cjs");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-done-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "done.json");
  const events = [];
  const settings = createDoneSettings({ file, emit: (channel, payload) => events.push([channel, payload]) });
  return { file, events, settings };
}

test("Done settings start at 24 hours, save a listed retention and tell every view", (t) => {
  const { file, events, settings } = setup(t);
  assert.deepEqual(settings.read(), { retentionHours: 24 });
  assert.deepEqual(settings.save({ retentionHours: 0 }), { retentionHours: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { retentionHours: 0 });
  assert.deepEqual(events, [["done:settings", { retentionHours: 0 }]]);
  assert.deepEqual(settings.save({ retentionHours: 7 }), { retentionHours: 24 }, "an unlisted retention goes back to the default");
  assert.throws(() => settings.save(null), /object/);
});

test("a damaged file reads as the defaults", (t) => {
  const { file, settings } = setup(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  assert.deepEqual(settings.read(), { retentionHours: 24 });
});
