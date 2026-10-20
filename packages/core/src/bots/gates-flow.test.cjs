const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBotHome } = require("./home.cjs");
const { createBotStore } = require("./store.cjs");
const { createBots } = require("./index.cjs");

const NOW = 1_000_000;
const META = Object.freeze({
  kind: "merge",
  title: "Merge PR #474",
  command: "gh pr merge 474 --squash",
  target: "/p",
  botId: "ops",
  botName: "Ops",
  expiresAt: NOW + 3_600_000,
});

// The service on a real store and home, with fake agent sessions (they record answers) and Chats (they record sends).
async function harness(t, { store, home } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-bots-gates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  home ??= await createBotHome(path.join(dir, "bots"), "ops");
  const OPS = {
    id: "ops",
    name: "Ops",
    role: "Keeps main green and PRs moving",
    color: "#3b82f6",
    body: "circle",
    provider: "claude",
    model: "claude-sonnet",
    projects: ["/p"],
    paused: false,
    homePath: home,
    homeWorktreeId: 1,
    threadSessionId: 1,
    createdAt: NOW,
  };
  if (!store) {
    store = createBotStore(path.join(dir, "angelo.db"));
    store.setEnabled(true);
    store.insertBot(OPS);
    store.linkChat({ chatKey: "/p#4", botId: "ops", title: "Fix flaky terminal-perf test", projectPath: "/p", status: "running", createdAt: NOW });
  }
  const agents = {
    responses: [],
    reachable: true,
    hasSession: () => false,
    respondToPermission(...args) {
      this.responses.push(args);
      return this.reachable;
    },
    closeChat: async () => {},
  };
  const chats = {
    sent: [],
    async send(request) {
      this.sent.push(request);
      return { sessionId: request.sessionId };
    },
  };
  const opened = [];
  const bots = createBots({
    dataDir: dir,
    store,
    chats,
    agents,
    openHome: async (projectPath) => {
      opened.push(projectPath);
      return { state: {} };
    },
    now: () => NOW,
  });
  t.after(() => bots.close());
  return { bots, store, agents, chats, opened, OPS, THREAD: `${home}#1` };
}

test("non-gated requests are allowed", async (t) => {
  const { bots, THREAD } = await harness(t);
  assert.equal(bots.policyFor(THREAD)({ tool: "Bash", command: "gh pr view 1" }), "allow");
  assert.equal(bots.policyFor("/p#4")({ tool: "Bash", command: "npm test" }), "allow");
});

test("Chats no bot runs have no policy", async (t) => {
  const { bots } = await harness(t);
  assert.equal(bots.policyFor("/p#5"), undefined);
});

test("a gated request becomes a sign-off that expires in an hour", async (t) => {
  const { bots } = await harness(t);
  const result = bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474 --squash" });
  assert.equal(result.gate.kind, "merge");
  assert.equal(result.gate.title, "Merge PR #474");
  assert.equal(result.gate.target, "/p");
  assert.equal(result.gate.expiresAt, NOW + 3_600_000);
  assert.equal(result.gate.botId, "ops");
  assert.equal(result.gate.botName, "Ops");
});

test("asking records nothing: the card is recorded when it is published", async (t) => {
  const { bots, store } = await harness(t);
  bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474" });
  assert.deepEqual(store.pendingGates(), []);
  await bots.observe("/p#5", { type: "permission-request", requestId: "r0", gate: META });
  assert.deepEqual(store.pendingGates(), []);
});

test("a grant lets the gate through", async (t) => {
  const { bots, store } = await harness(t);
  store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: NOW });
  assert.equal(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474" }), "allow");
  // A grant is for one target: another repository still asks.
  assert.ok(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 1 -R the-org/other" }).gate);
});

test("one grant doesn't let a whole compound command through", async (t) => {
  const { bots, store } = await harness(t);
  store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: NOW });
  const { gate } = bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474 && npm publish" });
  assert.equal(gate.kind, "merge");
  assert.equal(gate.title, "Merge PR #474 and 1 more");
  assert.equal(gate.command, "gh pr merge 474 && npm publish");
  assert.deepEqual(
    gate.actions.map(({ kind, target }) => [kind, target]),
    [
      ["merge", "/p"],
      ["publish", "/p"],
    ],
  );
  // Always grants every action on the card, so the same command goes through next time.
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate });
  await bots.answerGate("/p#4", "r1", "always");
  assert.deepEqual(
    store.grants("ops").map((grant) => grant.gate),
    ["merge", "publish"],
  );
  assert.equal(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474 && npm publish" }), "allow");
});

test("no grant covers a target Milagre can't be sure of, and Always on it allows once", async (t) => {
  const { bots, store } = await harness(t);
  store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: NOW });
  store.addGrant({ botId: "ops", gate: "merge", target: "the-ptf/milagre", createdAt: NOW });
  for (const command of ["cd ../other && gh pr merge 1", "gh pr merge 1 -R evil/x -R the-ptf/milagre", "GH_REPO=evil/x gh pr merge 1"]) {
    const { gate } = bots.policyFor("/p#4")({ tool: "Bash", command });
    assert.equal(gate?.target, null, command);
  }
  const { gate } = bots.policyFor("/p#4")({ tool: "Bash", command: "cd ../other && gh pr merge 1" });
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate });
  assert.equal((await bots.answerGate("/p#4", "r1", "always")).status, "allowed");
  assert.equal(store.grants("ops").length, 2);
});

test("a published gate shows in the snapshot, Always adds a grant and allows", async (t) => {
  const { bots, store, agents } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  assert.equal(bots.snapshot().gates.length, 1);
  assert.equal(bots.snapshot().bots[0].pendingGates, 1);
  const answered = await bots.answerGate("/p#4", "r1", "always");
  assert.equal(answered.status, "allowed");
  assert.deepEqual(agents.responses, [["/p#4", "r1", "allow"]]);
  assert.equal(store.hasGrant("ops", "merge", "/p"), true);
  // The resolved event that follows changes nothing.
  await bots.observe("/p#4", { type: "permission-resolved", requestId: "r1", decision: "allow" });
  assert.equal(store.gate("/p#4", "r1").status, "allowed");
  assert.equal(bots.snapshot().bots[0].pendingGates, 0);
});

test("Deny denies, and a second answer does nothing", async (t) => {
  const { bots, agents, store } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  await bots.answerGate("/p#4", "r1", "deny");
  await bots.answerGate("/p#4", "r1", "once");
  assert.deepEqual(agents.responses, [["/p#4", "r1", "deny"]]);
  assert.equal(store.gate("/p#4", "r1").status, "denied");
  await assert.rejects(bots.answerGate("/p#4", "r1", "maybe"), /Unknown sign-off/);
});

test("sign-offs with the same request id in two Chats stay apart", async (t) => {
  // Codex and ACP number their requests per session, so ids repeat across Chats.
  const { bots, store, agents, THREAD } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  await bots.observe(THREAD, { type: "permission-request", requestId: "r1", gate: { ...META, title: "Publish: npm publish", kind: "publish" } });
  assert.equal(bots.snapshot().gates.length, 2);
  await bots.answerGate(THREAD, "r1", "deny");
  assert.deepEqual(agents.responses, [[THREAD, "r1", "deny"]]);
  assert.equal(store.gate(THREAD, "r1").status, "denied");
  assert.equal(store.gate("/p#4", "r1").status, "pending");
  // The other Chat's card resolving doesn't end this one.
  await bots.observe(THREAD, { type: "permission-resolved", requestId: "r1", decision: "allow" });
  assert.equal(store.gate("/p#4", "r1").status, "pending");
  assert.equal((await bots.answerGate("/p#4", "r1", "once")).status, "allowed");
  await assert.rejects(bots.answerGate("/p#5", "r1", "once"), /no longer there/);
});

test("a card answered from the Chat itself ends the sign-off too", async (t) => {
  const { bots, store } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  await bots.observe("/p#4", { type: "permission-resolved", requestId: "r1", decision: "cancelled" });
  assert.equal(store.gate("/p#4", "r1").status, "denied");
});

test("a sign-off whose session is gone expires instead", async (t) => {
  const { bots, agents } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  agents.reachable = false;
  assert.equal((await bots.answerGate("/p#4", "r1", "once")).status, "expired");
});

test("an hour later the gate expires, is denied and the bot is told", async (t) => {
  const { bots, agents, store, chats, OPS } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  await bots.sweep(NOW + 3_599_999);
  assert.equal(store.gate("/p#4", "r1").status, "pending");
  await bots.sweep(NOW + 3_600_001);
  assert.deepEqual(agents.responses.at(-1), ["/p#4", "r1", "deny"]);
  assert.equal(store.gate("/p#4", "r1").status, "expired");
  assert.equal(chats.sent.at(-1).projectPath, OPS.homePath);
  assert.equal(chats.sent.at(-1).permissionMode, "bot");
  assert.equal(chats.sent.at(-1).context.kind, "bot-gate-expired");
  assert.match(chats.sent.at(-1).body, /^Sign-off for Merge PR #474 expired\. The user didn't answer within an hour, so it counts as denied\./);
  assert.equal(bots.snapshot().gates[0].status, "expired");
});

test("an expired sign-off reaches no paused bot", async (t) => {
  const { bots, store, chats } = await harness(t);
  await bots.observe("/p#4", { type: "permission-request", requestId: "r1", gate: META });
  store.updateBot("ops", { paused: true });
  const paused = await harness(t, { store, home: store.getBot("ops").homePath });
  await paused.bots.sweep(NOW + 3_600_001);
  assert.equal(store.gate("/p#4", "r1").status, "expired");
  assert.deepEqual([...chats.sent, ...paused.chats.sent], []);
});

test("pending gates from before a restart are expired at start", async (t) => {
  const first = await harness(t);
  first.store.recordGate({ requestId: "r9", botId: "ops", chatKey: "/p#4", meta: META, status: "pending", createdAt: NOW });
  const second = await harness(t, { store: first.store, home: first.OPS.homePath });
  await second.bots.start();
  assert.equal(first.store.gate("/p#4", "r9").status, "expired");
  assert.deepEqual(second.opened, [first.OPS.homePath]);
});

test("revoking a grant brings the gate back", async (t) => {
  const { bots, store } = await harness(t);
  const grant = store.addGrant({ botId: "ops", gate: "merge", target: "/p", createdAt: NOW });
  assert.equal(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 1" }), "allow");
  await bots.revokeGrant(grant.id);
  assert.ok(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 1" }).gate);
  assert.deepEqual(bots.snapshot().grants, []);
});

test("with Bots turned off, running bot Chats keep their gates", async (t) => {
  const { bots, store } = await harness(t);
  store.setEnabled(false);
  assert.ok(bots.policyFor("/p#4")({ tool: "Bash", command: "gh pr merge 474" }).gate);
});
