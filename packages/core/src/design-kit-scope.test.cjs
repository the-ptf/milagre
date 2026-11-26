const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDesignKits } = require("./design-kits.cjs");
const { createDesignKitScope } = require("./design-kit-scope.cjs");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { scopeKey } = require("@milagre/shared/chat-scopes");

const kit = { title: "App", colors: { ink: "#123456" }, textStyles: { body: { fontSize: 17 } }, spacing: { md: 16 }, radii: { card: 12 } };
const LINK = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const linkKey = scopeKey({ kind: "link", linkId: LINK });

async function fixture(t, group) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kit-scope-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registry = {
    projects: [
      { id: "web", path: "/repos/web" },
      { id: "app", path: "/repos/app" },
    ],
    projectGroups: [{ id: LINK, name: "Shop", projectIds: ["web", "app"], ...group }],
  };
  const scope = createDesignKitScope({
    projectRegistry: () => ({ snapshot: async () => registry }),
    scopeStates: () => new Map([[linkKey, Promise.resolve({ sessions: { 1: {} } })]]),
    kits: { adopt: (...args) => kits.adopt(...args) },
  });
  const kits = createDesignKits({ directory, projectForChat: async (chatId) => scope.project(chatId.slice(0, chatId.lastIndexOf("#"))) });
  return { directory, registry, scope, kits };
}

test("a Named Link's Chats follow its chosen member's design system, adopting the Link's old kit only where the member has none", async (t) => {
  const { directory, scope, kits, registry } = await fixture(t);
  const before = createDesignKits({ directory, projectForChat: async () => linkKey });
  await before.save({ chatId: `${linkKey}#1`, expectedVersion: 0, kit: { ...kit, title: "Link kit" } });
  await kits.save({ chatId: "/repos/app#1", expectedVersion: 0, kit: { ...kit, title: "App kit" } });
  registry.projectGroups[0].designSystemProjectId = "web";
  await kits.save({ chatId: `${linkKey}#1`, expectedVersion: 1, kit: { ...kit, title: "Link kit" } });
  delete registry.projectGroups[0].designSystemProjectId;

  assert.equal((await kits.read({ chatId: `${linkKey}#1` })).title, "Link kit");
  assert.equal((await kits.read({ chatId: "/repos/web#1" })).title, "Link kit");
  assert.deepEqual(await scope.followers("/repos/web"), ["/repos/web", linkKey]);
  assert.deepEqual(await scope.chats("/repos/web"), [`${linkKey}#1`]);

  registry.projectGroups[0].designSystemProjectId = "app";
  assert.equal((await kits.read({ chatId: `${linkKey}#1` })).title, "App kit");
  assert.deepEqual(await scope.followers("/repos/web"), ["/repos/web"]);
  assert.deepEqual(await scope.followers("/repos/app"), ["/repos/app", linkKey]);

  const designs = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat: async () => {}, readKit: (request) => kits.read(request) });
  const pinned = await kits.read({ chatId: `${linkKey}#1` });
  const document = { schemaVersion: 1, width: 390, height: 844, kit: pinned, nodes: [{ id: "box", type: "frame", width: 10, height: 10, fill: "$ink" }] };
  await designs.showDesign({ chatId: `${linkKey}#1`, id: "home", title: "Home", document });

  registry.projectGroups[0].projectIds = ["web", "other"];
  await assert.rejects(kits.read({ chatId: `${linkKey}#1` }), { code: "DESIGN_KIT_FROZEN" });
  const edited = await designs.apply({
    chatId: `${linkKey}#1`,
    id: "home",
    expectedVersion: 1,
    operations: [{ op: "update", id: "box", patch: { width: 20 } }],
  });
  assert.equal(edited.document.kit.title, "App kit");
});

test("a Link screen pinned to another owner's kit stays on it and keeps taking layer edits", async (t) => {
  const { directory, kits, registry } = await fixture(t);
  const before = createDesignKits({ directory, projectForChat: async () => linkKey });
  const linkKit = await before.save({ chatId: `${linkKey}#1`, expectedVersion: 0, kit: { ...kit, title: "Link kit" } });
  const designs = createChatArtifacts({
    directory: path.join(directory, "artifacts"),
    validateChat: async () => {},
    readKit: (request) => before.read(request),
  });
  const document = { schemaVersion: 1, width: 390, height: 844, kit: linkKit, nodes: [{ id: "box", type: "frame", width: 10, height: 10, fill: "$ink" }] };
  await designs.showDesign({ chatId: `${linkKey}#1`, id: "home", title: "Home", document });

  await kits.save({ chatId: "/repos/app#1", expectedVersion: 0, kit: { ...kit, title: "App kit", colors: { ink: "#000000" } } });
  await kits.save({ chatId: "/repos/app#1", expectedVersion: 1, kit: { ...kit, title: "App kit", colors: { ink: "#ffffff" } } });
  registry.projectGroups[0].designSystemProjectId = "app";
  const scoped = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat: async () => {}, readKit: (request) => kits.read(request) });
  const read = await scoped.get({ chatId: `${linkKey}#1`, id: "home" });
  assert.equal(read.document.kit.title, "Link kit");
  assert.equal(read.kitFollowed, undefined);
  assert.equal((await scoped.list({ chatId: `${linkKey}#1`, format: "design" }))[0].kit.title, "Link kit");
  assert.equal((await scoped.list({ chatId: `${linkKey}#1`, format: "design" }))[0].kit.version, 1);
  const edited = await scoped.apply({
    chatId: `${linkKey}#1`,
    id: "home",
    expectedVersion: 1,
    operations: [{ op: "update", id: "box", patch: { width: 20 } }],
  });
  assert.equal(edited.document.kit.title, "Link kit");
});

test("a design system save resolves its Project once for the version, its decision, the notice and the report", async (t) => {
  const { designKitToolDefinitions } = require("./design-kits.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-kit-owner-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const owners = ["/repos/web", "/repos/app"];
  const kits = createDesignKits({ directory, projectForChat: async () => owners.shift() ?? "/repos/other" });
  const seen = [];
  const save = designKitToolDefinitions(`${linkKey}#1`, kits, {
    changed: (_chat, _kit, project) => seen.push(["changed", project]),
    report: (_chat, _kit, project) => (seen.push(["report", project]), {}),
  }).find((tool) => tool.name === "design_kit_save");
  await save.run({ expectedVersion: 0, kit, decision: { summary: "Start" } });
  assert.deepEqual(seen, [
    ["changed", "/repos/web"],
    ["report", "/repos/web"],
  ]);
  const web = createDesignKits({ directory, projectForChat: async () => "/repos/web" });
  assert.equal((await web.history({ chatId: "x#1" }))[0].decision.summary, "Start");
});

test("a Named Link adopts its old kits into a member once, not on every read", async () => {
  const calls = [];
  const registry = {
    projects: [
      { id: "web", path: "/repos/web" },
      { id: "app", path: "/repos/app" },
    ],
    projectGroups: [{ id: LINK, name: "Shop", projectIds: ["web", "app"] }],
  };
  const scope = createDesignKitScope({
    projectRegistry: () => ({ snapshot: async () => registry }),
    scopeStates: () => new Map(),
    kits: { adopt: async (from, to) => calls.push([from, to]) },
  });
  await Promise.all([scope.project(linkKey), scope.project(linkKey), scope.project(linkKey)]);
  registry.projectGroups[0].designSystemProjectId = "app";
  await scope.project(linkKey);
  await scope.project(linkKey);
  assert.deepEqual(calls, [
    [linkKey, "/repos/web"],
    [linkKey, "/repos/app"],
  ]);
});

test("following a kit reads the pinned and latest versions from one resolved owner, and old entries keep their saved version", async () => {
  const { createLiveDesigns } = require("./design-kit-live.cjs");
  const v1 = { ...kit, id: "project", version: 1 };
  const v2 = { ...kit, id: "project", version: 2, title: "Newer" };
  const owners = ["/repos/web", "/repos/app"];
  const reads = [];
  const live = createLiveDesigns({
    kitOwner: async () => owners.shift(),
    readKit: async ({ owner, version }) => (reads.push(owner), version === 1 ? v1 : v2),
    implementation: () => ({}),
  });
  const entry = { version: 1, title: "Home", kit: { id: "project", version: 1, title: "App", fingerprint: live.fingerprint(v1) } };
  assert.equal((await live.entry("a#1", entry, new Map())).kit.version, 2);
  assert.deepEqual(reads, ["/repos/web", "/repos/web"]);
  const { fingerprint: _fingerprint, ...older } = entry.kit;
  assert.equal((await live.entry("a#1", { ...entry, kit: older }, new Map())).kit.version, 1);
});
