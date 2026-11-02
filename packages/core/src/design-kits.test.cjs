const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDesignKits } = require("./design-kits.cjs");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const kit = { title: "App", colors: { ink: "#123456" }, textStyles: { body: { fontSize: 17 } }, spacing: { md: 16 }, radii: { card: 12 } };

test("kits are shared by project, isolated between projects and immutable across updates/restarts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { directory, projectForChat: async (id) => id.split("#")[0] };
  const store = createDesignKits(options);
  const first = await store.save({ chatId: "a#1", expectedVersion: 0, kit });
  assert.deepEqual(await store.read({ chatId: "a#2" }), first);
  assert.equal(await store.read({ chatId: "b#1" }), null);
  await assert.rejects(store.save({ chatId: "a#2", expectedVersion: 0, kit }), /version conflict/);
  const updated = await store.save({ chatId: "a#2", expectedVersion: 1, kit: { ...kit, colors: { ink: "#abcdef" } } });
  assert.equal(updated.version, 2);
  const reopened = createDesignKits(options);
  assert.deepEqual(await reopened.read({ chatId: "a#3", version: 1 }), first);
  assert.deepEqual(await reopened.read({ chatId: "a#3" }), updated);
  const artifacts = createChatArtifacts({
    directory: path.join(directory, "artifacts"),
    validateChat: async () => {},
    readKit: (request) => store.read(request),
  });
  const document = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    kit: first,
    nodes: [{ id: "text", type: "text", textStyle: "body", text: "Hi", width: 100, height: 40, fill: "$ink" }],
  };
  await artifacts.showDesign({ chatId: "a#1", id: "screen", title: "Screen", document });
  await assert.rejects(artifacts.showDesign({ chatId: "b#1", id: "screen", title: "Screen", document }), /does not exist/);
  await assert.rejects(
    artifacts.showDesign({ chatId: "a#1", id: "forged", title: "Screen", document: { ...document, kit: { ...first, title: "Changed" } } }),
    /differs/,
  );
  assert.equal((await artifacts.get({ chatId: "a#1", id: "screen" })).document.kit.version, 1);
  const migrated = await artifacts.apply({ chatId: "a#1", id: "screen", expectedVersion: 1, operations: [{ op: "document", patch: { kit: updated } }] });
  assert.equal(migrated.document.tokens.ink, "#abcdef");
  assert.equal((await artifacts.get({ chatId: "a#1", id: "screen", version: 1 })).document.tokens.ink, "#123456");
});

test("invalid component trees and authorization failure do not save a kit", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createDesignKits({ directory, projectForChat: async () => "a" });
  await assert.rejects(
    store.save({ chatId: "a", expectedVersion: 0, kit: { ...kit, components: { button: [{ id: "button", type: "text", width: 100, height: 40 }] } } }),
    /root main component/,
  );
  let calls = 0;
  await assert.rejects(
    store.save(
      { chatId: "a", expectedVersion: 0, kit },
      {
        assertActive: () => {
          if (++calls === 2) throw Error("revoked");
        },
      },
    ),
    /revoked/,
  );
  assert.equal(await store.read({ chatId: "a" }), null);
});

test("public snapshots keep resolved appearance and omit kit references and property metadata", () => {
  const { publicPageContent } = require("./design-page-content.cjs");
  const snapshot = publicPageContent({
    schemaVersion: 1,
    designs: [
      {
        title: "Screen",
        document: {
          schemaVersion: 1,
          width: 390,
          height: 844,
          kit: { ...kit, id: "project", version: 1, references: [{ title: "Internal", source: "/private/identity" }] },
          nodes: [{ id: "title", type: "text", text: "Public copy", textStyle: "body", width: 300, height: 40, fill: "$ink" }],
        },
      },
    ],
  });
  const raw = JSON.stringify(snapshot);
  assert.doesNotMatch(raw, /private|references|textStyle|componentProperties|componentValues/);
  assert.equal(snapshot.designs[0].document.nodes[0].fontSize, 17);
  assert.equal(snapshot.designs[0].document.nodes[0].fill, "#123456");
});

test("strict saves and preflight reject drift atomically; advisory and explicit exceptions remain editable", async (t) => {
  const { createChatArtifacts, artifactToolDefinitions } = require("./chat-artifacts.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "strict-design-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const api = createChatArtifacts({ directory, validateChat: async () => {} });
  const document = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    background: "$ink",
    kit: { ...kit, id: "project", version: 1 },
    consistency: { mode: "strict" },
    nodes: [{ id: "text", type: "text", width: 200, height: 80, text: "Hello", textStyle: "body", fill: "$ink" }],
  };
  const saved = await api.showDesign({ chatId: "a", id: "screen", title: "Screen", document });
  assert.equal(saved.consistency.mode, "strict");
  const operations = [{ op: "update", id: "text", patch: { fill: "red" } }];
  await assert.rejects(api.apply({ chatId: "a", id: "screen", expectedVersion: 1, operations }), { code: "DESIGN_KIT_DRIFT" });
  await assert.rejects(
    api.showDesign({
      chatId: "a",
      id: "screen",
      expectedVersion: 1,
      title: "Changed",
      document: { ...document, nodes: [{ ...document.nodes[0], fill: "red" }] },
    }),
    { code: "DESIGN_KIT_DRIFT" },
  );
  const stripped = { ...document, consistency: undefined, nodes: [{ ...document.nodes[0], fill: "red" }] };
  await assert.rejects(api.showDesign({ chatId: "a", id: "screen", expectedVersion: 1, title: "Changed", document: stripped }), { code: "DESIGN_KIT_DRIFT" });
  await assert.rejects(api.apply({ chatId: "a", id: "screen", expectedVersion: 1, operations: [{ op: "replace", document: stripped }] }), {
    code: "DESIGN_KIT_DRIFT",
  });
  const preflight = artifactToolDefinitions("a", api).find((x) => x.name === "design_validate");
  const check = JSON.parse(await preflight.run({ id: "screen", expectedVersion: 1, operations }));
  assert.equal(check.valid, false);
  assert.deepEqual(check.errors[0].path, ["nodes", 0, "fill"]);
  assert.equal(check.diagnostics.warnings.find((w) => w.kind === "kit-drift").actual, "red");
  assert.equal((await api.get({ chatId: "a", id: "screen" })).version, 1);
  const excepted = await api.apply({
    chatId: "a",
    id: "screen",
    expectedVersion: 1,
    operations: [
      ...operations,
      {
        op: "document",
        patch: { consistency: { mode: "strict", exceptions: [{ nodeId: "text", field: "fill", value: "red", reason: "User requested red warning" }] } },
      },
    ],
  });
  assert.equal(excepted.version, 2);
  const advisory = await api.apply({
    chatId: "a",
    id: "screen",
    expectedVersion: 2,
    operations: [
      { op: "document", patch: { consistency: { mode: "advisory" } } },
      { op: "update", id: "text", patch: { fill: "blue" } },
    ],
  });
  assert.equal(advisory.version, 3);
});
