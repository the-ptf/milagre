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
