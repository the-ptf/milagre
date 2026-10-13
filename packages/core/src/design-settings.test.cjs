const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDesignSettings } = require("./design-settings.cjs");

test("a corrupt Designs setting disables Designs without preventing the host from starting", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "design-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "designs.json");
  assert.equal(createDesignSettings(file).enabled(), true);
  for (const content of ["{", "null", "{}", '{"enabled":"false"}']) {
    fs.writeFileSync(file, content);
    const settings = createDesignSettings(file);
    assert.equal(settings.enabled(), false);
    assert.deepEqual(settings.save(true), { enabled: true });
    assert.equal(createDesignSettings(file).enabled(), true);
  }
});

test("a failed Designs setting save preserves memory, disk and the prior restart value", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "design-settings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "designs.json");
  const settings = createDesignSettings(file);
  assert.equal(settings.enabled(), true);
  assert.deepEqual(settings.save(false), { enabled: false });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file) throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
    return rename(from, to);
  });
  assert.throws(() => settings.save(true), /disk unavailable/);
  assert.equal(settings.enabled(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { enabled: false });
  assert.equal(createDesignSettings(file).enabled(), false);
  assert.deepEqual(fs.readdirSync(directory), ["designs.json"]);
});
