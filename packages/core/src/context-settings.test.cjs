const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createContextSettings } = require("./context-settings.cjs");
const { CONTEXT_DEFAULTS, normalizeContextSettings, shouldAutoCompact } = require("@milagre/shared/context-settings");

test("context settings persist on the host and broadcast normalized patches", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.json");
  const events = [];
  const settings = createContextSettings({ file, emit: (...event) => events.push(event) });
  assert.deepEqual(settings.read(), CONTEXT_DEFAULTS);
  settings.save({ buttonThreshold: 80 });
  settings.save({ autoThreshold: 91.6, autoCompact: true });
  assert.deepEqual(createContextSettings({ file }).read(), { buttonThreshold: 80, autoThreshold: 92, autoCompact: true });
  assert.deepEqual(events.at(-1), ["context:settings", settings.read()]);
  assert.throws(() => settings.save(null), /must be an object/);
  assert.throws(() => settings.save([]), /must be an object/);
  fs.writeFileSync(file, "broken JSON");
  assert.deepEqual(settings.read(), CONTEXT_DEFAULTS);
});

test("thresholds remain finite, separated and in range, including missing or invalid values", () => {
  for (const buttonThreshold of [undefined, NaN, Infinity, -20, 5, 70, 90, 110, "90"]) {
    for (const autoThreshold of [undefined, NaN, Infinity, -20, 80, 100, "85"]) {
      const value = normalizeContextSettings({ buttonThreshold, autoThreshold });
      assert.ok(value.buttonThreshold >= 5 && value.buttonThreshold <= 90);
      assert.ok(value.autoThreshold >= value.buttonThreshold + 5 && value.autoThreshold <= 95);
      assert.equal(value.autoCompact, false);
    }
  }
  const enabled = { ...CONTEXT_DEFAULTS, autoCompact: true };
  assert.equal(shouldAutoCompact(enabled, { used: 169999, size: 200000 }), false);
  assert.equal(shouldAutoCompact(enabled, { used: 170000, size: 200000 }), true);
  for (const usage of [null, { used: 10, size: 0 }, { used: NaN, size: 100 }, { used: Infinity, size: 100 }])
    assert.equal(shouldAutoCompact(enabled, usage), false);
  assert.equal(shouldAutoCompact(CONTEXT_DEFAULTS, { used: 200000, size: 200000 }), false);
});
