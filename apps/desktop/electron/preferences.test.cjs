const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPreferencesStore } = require("./preferences.cjs");

test("preferences survive process restart, app relocation and deletion", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-preferences-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "profile", "preferences.json");
  const first = createPreferencesStore(file);
  first.set("milagre-settings", JSON.stringify({ theme: "dark", colorTheme: "nord", appearance: { motion: "off" } }));
  first.set("milagre.composer-preferences", '{"chat-1":{"effort":"high"}}');
  first.set("milagre.chat-preferences", '{"isolation":"worktree"}');
  first.set("milagre:diff-layout", "split");
  const updated = createPreferencesStore(file);
  assert.equal(updated.get("milagre:diff-layout"), "split");
  assert.equal(updated.get("milagre-settings"), first.get("milagre-settings"));
  assert.equal(updated.get("milagre.composer-preferences"), first.get("milagre.composer-preferences"));
  assert.equal(updated.get("milagre.chat-preferences"), first.get("milagre.chat-preferences"));
  updated.set("milagre.chat-preferences", null);
  assert.equal(createPreferencesStore(file).get("milagre.chat-preferences"), null);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.throws(() => updated.set("unrelated", "bad"));
});

for (const corrupt of ["{incomplete", "null", "[]", "42"])
  test(`corrupt preferences recover and preserve the original: ${corrupt}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-preferences-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "preferences.json");
    const warn = t.mock.method(console, "warn", () => {});
    fs.writeFileSync(file, corrupt);
    const store = createPreferencesStore(file);
    assert.equal(store.get("milagre-settings"), undefined);
    const backup = fs.readdirSync(dir).find((name) => /^preferences.json.corrupt-\d+$/.test(name));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(dir, backup), "utf8"), corrupt);
    assert.equal(warn.mock.calls[0].arguments[1], file);
    store.set("milagre-settings", "fresh");
    assert.equal(createPreferencesStore(file).get("milagre-settings"), "fresh");
  });

test("preferences still throw real I/O errors", (t) => {
  const error = Object.assign(new Error("access denied"), { code: "EACCES" });
  t.mock.method(fs, "readFileSync", () => {
    throw error;
  });
  assert.throws(() => createPreferencesStore("/preferences.json"), error);
});

test("preferences recover even when preserving the corrupt file fails", (t) => {
  t.mock.method(fs, "readFileSync", () => "{");
  t.mock.method(fs, "renameSync", () => {
    throw new Error("access denied");
  });
  t.mock.method(console, "warn", () => {});
  assert.equal(createPreferencesStore("/preferences.json").get("milagre-settings"), undefined);
});
