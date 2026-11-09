const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpStore } = require("./store.cjs");

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const pencil = { name: "pencil", type: "stdio", command: "pencil", args: ["mcp"], env: {} };

test("a missing file reads empty", (t) => {
  assert.deepEqual(createMcpStore(path.join(folder(t), "mcp.json")).read(), { everywhere: [], off: {} });
});

test("everywhere and off persist at mode 0600", (t) => {
  const file = path.join(folder(t), "mcp.json");
  const store = createMcpStore(file);
  store.setEverywhere([pencil]);
  store.setOff("codex", "default", "pencil", true);
  store.setOff("codex", "default", "pencil", true);
  assert.deepEqual(createMcpStore(file).read(), { everywhere: [pencil], off: { "codex:default": ["pencil"] } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.setOff("codex", "default", "pencil", false);
  assert.deepEqual(store.offFor("codex", "default"), []);
  assert.deepEqual(store.read().off, {});
});

test("a corrupt file reads empty and is replaced on the next write", (t) => {
  const file = path.join(folder(t), "mcp.json");
  fs.writeFileSync(file, "{nope");
  const store = createMcpStore(file);
  assert.deepEqual(store.read(), { everywhere: [], off: {} });
  store.setEverywhere([pencil]);
  assert.equal(store.read().everywhere.length, 1);
});

test("a corrupt file is kept aside as mcp.json.corrupt-<time> before the next write", (t) => {
  const dir = folder(t);
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, "{nope");
  const store = createMcpStore(file);
  store.setEverywhere([pencil]);
  const aside = fs.readdirSync(dir).filter((name) => name.startsWith("mcp.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{nope");
  store.setOff("claude", "default", "pencil", true);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("mcp.json.corrupt-")).length, 1, "a good file is never moved aside");
});
