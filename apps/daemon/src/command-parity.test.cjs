const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");
const { catalogue } = require("./product-commands.cjs");
const generated = require("../../../packages/core/src/command-contracts.json");
test("every UI action is discoverable as an owner command or a declared desktop capability", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-parity-"));
  const daemon = await startDaemon({ dataDir, version: "test", runtimeOptions: { environmentReady: Promise.resolve() } });
  t.after(async () => {
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const client = await connect({ dataDir });
  t.after(() => client.close());
  const entries = await catalogue(client);
  const names = new Set(entries.map((c) => c.name));
  const mobile = require("./mobile-bridge.cjs").METHODS;
  assert.deepEqual(
    [...mobile].filter((name) => !names.has(name)),
    [],
  );
  const missing = Object.keys(generated.commands).filter((name) => !names.has(name) && !names.has(`desktop:${name}`));
  assert.deepEqual(missing, []);
  for (const entry of entries) {
    assert.equal(entry.inputSchema.type, "object", entry.name);
    assert.ok(entry.parameters, entry.name);
  }
  assert.equal(entries.find((e) => e.name === "desktop:editor:list").available, false);
});

test("bridge input contracts are regenerated whenever UI types change", () => {
  require("node:child_process").execFileSync(process.execPath, [path.resolve(__dirname, "../../../scripts/generate-command-contracts.cjs"), "--check"]);
});
