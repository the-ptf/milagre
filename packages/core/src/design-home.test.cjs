const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDesignKits } = require("./design-kits.cjs");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { createDesignHome } = require("./design-home.cjs");

const kit = { title: "Shop", colors: { ink: "#123456" }, textStyles: { body: { fontSize: 17 } }, spacing: { md: 16 }, radii: { card: 12 } };

async function fixture(t, { frozen = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-home-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const kits = createDesignKits({ directory: path.join(directory, "kits"), projectForChat: async (chatId) => chatId.slice(0, chatId.lastIndexOf("#")) });
  const designs = createChatArtifacts({ directory: path.join(directory, "artifacts"), validateChat: async () => {} });
  const sessions = { 1: { title: "Checkout" }, 2: { generatedTitle: "Onboarding", archived: true }, 3: {}, 4: { title: "No designs" } };
  const home = createDesignHome({
    scope: async (request) => request.projectPath,
    kitScope: {
      project: async (key) => {
        if (frozen) throw Object.assign(new Error("frozen"), { code: "DESIGN_KIT_FROZEN" });
        return key;
      },
    },
    kits,
    designs,
    scopeStates: () => new Map([["/repos/shop", Promise.resolve({ sessions })]]),
    chatTitle: (session) => session.title || session.generatedTitle || "New Chat",
  });
  return { kits, designs, home };
}

const screen = { schemaVersion: 1, width: 390, height: 844, nodes: [{ id: "box", type: "frame", width: 10, height: 10, fill: "#000000" }] };

test("the Designs page reads the Project's design system as one board with its decisions, newest first", async (t) => {
  const { kits, home } = await fixture(t);
  assert.deepEqual(await home.system({ projectPath: "/repos/shop" }), { kit: null, history: [] });
  await kits.save({ chatId: "/repos/shop#1", expectedVersion: 0, kit });
  await kits.recordDecision({ chatId: "/repos/shop#1", version: 1, decision: { summary: "Start" } });
  await kits.save({ chatId: "/repos/shop#1", expectedVersion: 1, kit: { ...kit, radii: { card: 20 } } });
  await kits.recordDecision({ chatId: "/repos/shop#1", version: 2, decision: { summary: "Softer cards", reason: "Asked by the user" } });
  const view = await home.system({ projectPath: "/repos/shop" });
  assert.deepEqual(view.kit, { id: "project", version: 2, title: "Shop" });
  assert.deepEqual(
    view.history.map((entry) => entry.decision.summary),
    ["Softer cards", "Start"],
  );
  assert.match(view.svg, /^<svg[\s\S]*Shop design system/);
  assert.ok(view.width > 0 && view.height > 0);
});

test("a frozen Named Link's Designs page says so instead of failing", async (t) => {
  const { home } = await fixture(t, { frozen: true });
  assert.deepEqual(await home.system({ projectPath: "/repos/shop" }), { frozen: true, kit: null, history: [] });
});

test("the Designs page lists every Chat with designs, archived ones last", async (t) => {
  const { designs, home } = await fixture(t);
  await designs.showDesign({ chatId: "/repos/shop#1", id: "cart", title: "Cart", document: screen });
  await designs.showDesign({ chatId: "/repos/shop#2", id: "welcome", title: "Welcome", document: screen });
  await designs.showDesign({ chatId: "/repos/shop#3", id: "account", title: "Account", document: screen });
  const chats = await home.chats({ projectPath: "/repos/shop" });
  assert.deepEqual(
    chats.map((chat) => [chat.title, chat.archived, chat.designs.map((item) => item.id)]),
    [
      ["New Chat", false, ["account"]],
      ["Checkout", false, ["cart"]],
      ["Onboarding", true, ["welcome"]],
    ],
  );
});
