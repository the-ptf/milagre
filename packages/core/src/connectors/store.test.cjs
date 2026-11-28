const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectorStore } = require("./store.cjs");

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createConnectorStore({ dataDir }) };
}

const connector = (id) => ({ id, name: id, url: `https://${id}.example/mcp` });

test("a damaged connectors.json is kept and refused, not overwritten by the next save or remove", (t) => {
  const { dataDir, store } = fixture(t);
  store.save(connector("notion"));
  const file = path.join(dataDir, "connectors", "connectors.json");
  fs.writeFileSync(file, '{"connectors":[{"id":"notion"');
  assert.throws(() => store.save(connector("linear")), /damaged/);
  assert.throws(() => store.remove("notion"), /damaged/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"connectors":[{"id":"notion"');
  assert.equal(fs.readFileSync(`${file}.bad`, "utf8"), '{"connectors":[{"id":"notion"');
});

test("a missing connectors.json still starts empty", (t) => {
  const { store } = fixture(t);
  store.save(connector("notion"));
  assert.deepEqual(
    store.list().map((item) => item.id),
    ["notion"],
  );
});

test("a damaged secrets file keeps its refresh token when a patch arrives", (t) => {
  const { dataDir, store } = fixture(t);
  store.secrets("notion").update({ refresh: "r1" });
  const file = path.join(dataDir, "connectors", "secrets", "notion.json");
  fs.writeFileSync(file, '{"refresh":"r1"');
  assert.throws(() => store.secrets("notion").update({ access: "a2" }), /damaged/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"refresh":"r1"');
});
