const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBotStore } = require("./store.cjs");

const OPS = Object.freeze({
  id: "ops",
  name: "Ops",
  role: "Keeps main green and PRs moving",
  color: "#3b82f6",
  body: "circle",
  provider: "claude",
  model: "claude-sonnet",
  projects: ["/p"],
  paused: false,
  homePath: "/d/bots/ops",
  homeWorktreeId: 1,
  threadSessionId: 1,
  createdAt: 1,
});
const META = Object.freeze({ kind: "merge", title: "Merge PR #474", command: "gh pr merge 474", target: "/p", botId: "ops", botName: "Ops", expiresAt: 10 });
const CHAT = Object.freeze({ chatKey: "/p#4", botId: "ops", title: "Fix flaky test", projectPath: "/p", status: "running", createdAt: 1 });

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-bots-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function open(t, file = path.join(tmp(t), "angelo.db")) {
  const store = createBotStore(file);
  t.after(() => store.close());
  return store;
}

test("bots, gates, grants and chats round-trip", (t) => {
  const store = open(t);
  assert.equal(store.enabled(), false);
  store.setEnabled(true);
  assert.equal(store.enabled(), true);
  store.insertBot(OPS);
  assert.equal(store.getBot("ops").name, "Ops");
  assert.equal(store.getBot("chief"), null);
  assert.equal(store.updateBot("ops", { paused: true, id: "other" }).paused, true);
  assert.deepEqual(
    store.listBots().map((bot) => [bot.id, bot.paused]),
    [["ops", true]],
  );
  store.recordGate({ requestId: "r1", botId: "ops", chatKey: "/p#4", meta: META, status: "pending", createdAt: 1 });
  assert.deepEqual(store.expiredGates(9), []);
  assert.deepEqual(
    store.expiredGates(11).map((gate) => gate.requestId),
    ["r1"],
  );
  assert.deepEqual(store.gate("r1"), { requestId: "r1", botId: "ops", chatKey: "/p#4", meta: META, status: "pending", createdAt: 1 });
  store.setGateStatus("r1", "allowed");
  assert.equal(store.gate("r1").status, "allowed");
  assert.deepEqual(store.pendingGates(), []);
  const grant = store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: 1 });
  assert.equal(store.hasGrant("ops", "merge", "/p"), true);
  assert.equal(store.hasGrant("ops", "merge", "/q"), false);
  assert.equal(store.hasGrant("ops", "publish", "/p"), false);
  assert.deepEqual(store.grants("ops"), [{ ...grant, revokedAt: null }]);
  store.revokeGrant(grant.id, 2);
  assert.equal(store.hasGrant("ops", "merge", "/p"), false);
  assert.deepEqual(store.grants(), []);
  store.linkChat(CHAT);
  assert.equal(store.chat("/p#4").status, "running");
  store.setChatStatus("/p#4", "done");
  assert.deepEqual(store.chatsFor("ops"), [{ ...CHAT, status: "done" }]);
  assert.equal(store.chat("/p#5"), null);
});

test("updating a bot that does not exist throws", (t) => {
  assert.throws(() => open(t).updateBot("ghost", { paused: true }), /No bot ghost\./);
});

test("deleting a bot removes its gates and grants but keeps its chat rows", (t) => {
  const store = open(t);
  store.insertBot(OPS);
  store.recordGate({ requestId: "r1", botId: "ops", chatKey: "/p#4", meta: META, status: "pending", createdAt: 1 });
  store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: 1 });
  store.linkChat(CHAT);
  store.deleteBot("ops");
  assert.equal(store.getBot("ops"), null);
  assert.equal(store.pendingGates().length, 0);
  assert.equal(store.grants("ops").length, 0);
  assert.equal(store.chat("/p#4").botId, "ops");
});

test("the store survives reopening and its file is private", (t) => {
  const file = path.join(tmp(t), "data", "angelo.db");
  const first = createBotStore(file);
  first.setEnabled(true);
  first.insertBot(OPS);
  first.close();
  const store = open(t, file);
  assert.equal(store.enabled(), true);
  assert.equal(store.getBot("ops").name, "Ops");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
