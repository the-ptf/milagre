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
  const live = await artifacts.get({ chatId: "a#1", id: "screen" });
  assert.equal(live.version, 1);
  assert.equal(live.document.tokens.ink, "#abcdef");
  assert.deepEqual(live.kitFollowed, { from: 1, to: 2 });
  assert.match(live.html, /#abcdef/);
  assert.deepEqual((await artifacts.list({ chatId: "a#1", format: "design" }))[0].kit, { id: "project", version: 2, title: "App" });
  const edited = await artifacts.apply({
    chatId: "a#1",
    id: "screen",
    expectedVersion: 1,
    operations: [{ op: "update", id: "text", patch: { text: "Hello" } }],
  });
  assert.equal(edited.document.kit.version, 2);
  assert.equal((await artifacts.get({ chatId: "a#1", id: "screen", version: 1 })).document.tokens.ink, "#123456");
  await artifacts.apply({ chatId: "a#1", id: "screen", expectedVersion: 2, operations: [{ op: "document", patch: { kitFrozen: true } }] });
  await store.save({ chatId: "a#2", expectedVersion: 2, kit: { ...kit, colors: { ink: "#000000" } } });
  const frozen = await artifacts.get({ chatId: "a#1", id: "screen" });
  assert.equal(frozen.document.tokens.ink, "#abcdef");
  assert.equal(frozen.kitFrozen, true);
  await artifacts.apply({ chatId: "a#1", id: "screen", expectedVersion: 3, operations: [{ op: "document", patch: { kitFrozen: false } }] });
  assert.equal((await artifacts.get({ chatId: "a#1", id: "screen" })).document.tokens.ink, "#000000");
  await store.save({ chatId: "a#2", expectedVersion: 3, kit: { ...kit, textStyles: {} } });
  const broken = await artifacts.get({ chatId: "a#1", id: "screen" });
  assert.equal(broken.document.kit.version, 2);
  assert.equal(broken.kitBroken.version, 4);
  assert.match(broken.kitBroken.message, /Text style "body" does not exist/);
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

test("intent preflight and agent/client writes enforce the same atomic contract", async (t) => {
  const { artifactToolDefinitions } = require("./chat-artifacts.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intent-design-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const api = createChatArtifacts({ directory, validateChat: async () => {} });
  await api.showDesign({
    chatId: "a",
    id: "screen",
    title: "Screen",
    document: {
      schemaVersion: 1,
      width: 390,
      height: 844,
      nodes: [{ id: "title", type: "text", width: 200, height: 24, text: "Hello", fill: "black" }],
    },
  });
  const tools = artifactToolDefinitions("a", api);
  const preflight = tools.find((x) => x.name === "design_validate");
  const apply = tools.find((x) => x.name === "design_apply");
  const request = {
    id: "screen",
    expectedVersion: 1,
    intent: { mode: "text-only", textIds: ["title"] },
    operations: [{ op: "update", id: "title", patch: { text: "Long text ".repeat(20), fill: "red" } }],
  };
  const rejected = JSON.parse(await preflight.run(request));
  assert.equal(rejected.valid, false);
  assert.equal(rejected.code, "DESIGN_INTENT_VIOLATION");
  assert.deepEqual(rejected.errors[0].path, ["nodes", 0, "fill"]);
  await assert.rejects(apply.run(request), { code: "DESIGN_INTENT_VIOLATION" });
  await assert.rejects(api.apply({ chatId: "a", ...request }), { code: "DESIGN_INTENT_VIOLATION" });
  assert.equal((await api.get({ chatId: "a", id: "screen" })).version, 1);
  delete request.operations[0].patch.fill;
  request.intent.mode = "fit-text";
  const clipped = JSON.parse(await preflight.run(request));
  assert.equal(clipped.valid, false);
  assert.ok(clipped.diagnostics.warnings[0].measurements.missingHeight > 0);
  request.operations.push(...clipped.diagnostics.warnings[0].suggestions[0].operations);
  const checked = JSON.parse(await preflight.run(request));
  assert.equal(checked.valid, true);
  assert.equal((await api.get({ chatId: "a", id: "screen" })).version, 1);
  const saved = await api.apply({ chatId: "a", ...request });
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.document, checked.document);
  await assert.rejects(api.apply({ chatId: "a", ...request }), /version conflict/);
  const mismatch = JSON.parse(await preflight.run({ document: checked.document, intent: request.intent }));
  assert.equal(mismatch.valid, false);
  const feedback = await apply.run({ ...request, expectedVersion: 2, intent: { mode: "text-only", textIds: ["title"] }, operations: [request.operations[0]] });
  assert.match(feedback.text, /text-only edit: report clipping/);
  assert.doesNotMatch(feedback.text, /fix what looks wrong/);
});

test("a kit save reports which screens of the Project follow it, stay frozen or can't follow it", async (t) => {
  const { designKitReport } = require("./design-kit-report.cjs");
  const { designKitToolDefinitions } = require("./design-kits.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kit-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kits = createDesignKits({ directory: path.join(directory, "kits"), projectForChat: async (id) => id.split("#")[0] });
  const designs = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat: async () => {}, readKit: (request) => kits.read(request) });
  const first = await kits.save({ chatId: "a#1", expectedVersion: 0, kit: { ...kit, textStyles: { body: { fontSize: 17 }, title: { fontSize: 28 } } } });
  const screen = (textStyle) => ({
    schemaVersion: 1,
    width: 390,
    height: 844,
    kit: first,
    nodes: [{ id: "text", type: "text", textStyle, text: "Hi", width: 100, height: 40, fill: "$ink" }],
  });
  await designs.showDesign({ chatId: "a#1", id: "home", title: "Home", document: screen("body") });
  await designs.showDesign({ chatId: "a#2", id: "hero", title: "Hero", document: screen("title") });
  await designs.showDesign({ chatId: "a#2", id: "old", title: "Old", document: { ...screen("body"), kitFrozen: true } });
  const changes = [];
  const save = designKitToolDefinitions("a#2", kits, {
    changed: (chatId, saved) => changes.push([chatId, saved.version]),
    report: (chatId, saved) => designKitReport({ kit: saved, chatId, chats: ["a#1", "a#2"], designs }),
  }).find((tool) => tool.name === "design_kit_save");
  const result = JSON.parse(await save.run({ expectedVersion: 1, kit: { ...kit, textStyles: { body: { fontSize: 18 } } } }));
  assert.equal(result.kit.version, 2);
  assert.deepEqual(changes, [["a#2", 2]]);
  assert.equal(result.screens.following, 1);
  assert.deepEqual(result.screens.frozen, [{ id: "old", title: "Old", chatId: "a#2", version: 1 }]);
  assert.equal(result.screens.broken.length, 1);
  assert.equal(result.screens.broken[0].id, "hero");
  assert.match(result.screens.broken[0].error, /"title" does not exist/);
  assert.equal((await designs.get({ chatId: "a#1", id: "home" })).document.nodes[0].fontSize, 18);
});

test("each design system version records its decision for the log, outside the snapshot screens pin", async (t) => {
  const { designKitToolDefinitions } = require("./design-kits.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kit-decisions-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kits = createDesignKits({ directory, projectForChat: async (id) => id.split("#")[0] });
  const tools = designKitToolDefinitions("a#1", kits);
  const save = tools.find((tool) => tool.name === "design_kit_save");
  const history = tools.find((tool) => tool.name === "design_kit_history");
  await save.run({ expectedVersion: 0, kit, decision: { summary: "Start from DESIGN.md" } });
  await save.run({
    expectedVersion: 1,
    kit: { ...kit, radii: { card: 20 } },
    decision: { summary: "Cards use a 20 px radius", reason: "The user wants softer cards everywhere" },
  });
  const log = JSON.parse(await history.run({}));
  assert.deepEqual(
    log.map(({ version, decision }) => ({ version, decision })),
    [
      { version: 1, decision: { summary: "Start from DESIGN.md" } },
      { version: 2, decision: { summary: "Cards use a 20 px radius", reason: "The user wants softer cards everywhere" } },
    ],
  );
  assert.ok(log.every((entry) => Number.isFinite(entry.savedAt)));
  const latest = await kits.read({ chatId: "a#2" });
  assert.equal(latest.version, 2);
  const [folder] = await fs.readdir(directory);
  const stored = JSON.parse(await fs.readFile(path.join(directory, folder, "project.json"), "utf8"));
  const { designKitSchema } = require("@milagre/shared/design");
  for (const entry of stored) designKitSchema.parse(entry);
  assert.deepEqual(stored.at(-1), latest);
});

test("a saved screen names off-system values and local components another screen repeats", async (t) => {
  const { artifactToolDefinitions } = require("./chat-artifacts.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-system-notes-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const api = createChatArtifacts({ directory, validateChat: async () => {} });
  const tools = artifactToolDefinitions("a", api, undefined, { renderPng: async () => ({ type: "image", data: "", mimeType: "image/png" }) });
  const show = tools.find((tool) => tool.name === "design_show");
  const chip = (id) => ({ id, type: "frame", component: true, name: "Chip", width: 80, height: 32, fill: "#eeeeee" });
  const screen = (nodes) => ({ schemaVersion: 1, width: 390, height: 844, kit: { ...kit, id: "project", version: 1 }, nodes });
  await show.run({ id: "one", title: "One", document: { ...screen([chip("chip")]), kit: undefined } });
  const second = await show.run({ id: "two", title: "Two", document: { ...screen([chip("tag")]), kit: undefined } });
  assert.match(second.text, /Local component "tag" \(also on "One"\)/);
  const drift = await show.run({ id: "three", title: "Three", document: screen([{ id: "box", type: "frame", width: 100, height: 100, fill: "red" }]) });
  assert.match(drift.text, /outside the design system/);
  const clean = await show.run({
    id: "four",
    title: "Four",
    document: { ...screen([{ id: "box", type: "frame", width: 100, height: 100, fill: "$ink" }]), background: "$ink" },
  });
  assert.doesNotMatch(clean.text, /outside the design system|Local component/);
});

test("a strict screen the newer kit would put in drift stays on its saved version", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kit-strict-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kits = createDesignKits({ directory: path.join(directory, "kits"), projectForChat: async (id) => id.split("#")[0] });
  const designs = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat: async () => {}, readKit: (request) => kits.read(request) });
  const first = await kits.save({ chatId: "a#1", expectedVersion: 0, kit });
  await designs.showDesign({
    chatId: "a#1",
    id: "strict",
    title: "Strict",
    document: {
      schemaVersion: 1,
      width: 390,
      height: 844,
      background: "$ink",
      kit: first,
      consistency: { mode: "strict" },
      nodes: [{ id: "card", type: "frame", width: 100, height: 100, fill: "$ink", radius: 12 }],
    },
  });
  await kits.save({ chatId: "a#1", expectedVersion: 1, kit: { ...kit, radii: { card: 20 } } });
  const read = await designs.get({ chatId: "a#1", id: "strict" });
  assert.equal(read.document.kit.version, 1);
  assert.equal(read.kitBroken.version, 2);
  const edited = await designs.apply({ chatId: "a#1", id: "strict", expectedVersion: 1, operations: [{ op: "update", id: "card", patch: { width: 120 } }] });
  assert.equal(edited.version, 2);
});
