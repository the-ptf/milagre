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

test("corrupt preferences are preserved instead of silently overwritten with defaults", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-preferences-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "preferences.json");
  fs.writeFileSync(file, "{incomplete");
  assert.throws(() => createPreferencesStore(file));
  assert.equal(fs.readFileSync(file, "utf8"), "{incomplete");
});
