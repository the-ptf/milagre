const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrchestratorStore } = require("./store.cjs");
const { createOrchestrator } = require("./service.cjs");
const { routeTask } = require("./router.cjs");
const { normalizeOrchestratorSettings } = require("@milagre/shared/orchestrator");

const PROJECTS = [
  { path: "/p/happiergym", name: "happiergym" },
  { path: "/p/rdfood", name: "rdfood" },
];

function setup(t, { reply = null, enabled = true, remote = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-orchestrator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const store = createOrchestratorStore({ file: path.join(dir, "orchestrator.json"), emit: (channel) => events.push(channel) });
  store.update((current) => ({ ...current, settings: normalizeOrchestratorSettings({ ...current.settings, enabled }) }));
  const calls = { sent: [], emptyChats: [], hidden: [], archived: [], stopped: [] };
  let nextSession = 7;
  const ports = {
    projects: async () => PROJECTS,
    selectedAccount: () => "default",
    accountUsage: async () => [
      { provider: "claude", accountId: "team", usedPercent: 61 },
      { provider: "claude", accountId: "personal", usedPercent: 22 },
    ],
    createWorktree: async () => "wt-1",
    projectWorktree: async () => "main",
    emptyChat: async (projectPath, worktreeId, options) => {
      calls.emptyChats.push({ projectPath, worktreeId, options });
      return nextSession++;
    },
    send: async (request) => calls.sent.push(request),
    setHidden: async (projectPath, sessionId, hidden) => calls.hidden.push({ projectPath, sessionId, hidden }),
    chatKey: (projectPath, sessionId) => `${projectPath}#${sessionId}`,
    stop: async (key) => calls.stopped.push(key),
    archive: async (projectPath, sessionId) => calls.archived.push({ projectPath, sessionId }),
    routerCall: () => (reply === null ? null : async () => JSON.stringify(reply)),
    remote,
    originOf: async (projectPath) => `git@github.com:me/${projectPath.split("/").pop()}`,
    capacity: async () => ({ cpu: 0.7, memoryFree: 0.2, agents: 3 }),
    withTimeout: (promise) => promise,
    wait: async () => {},
  };
  const orchestrator = createOrchestrator({ store, ports, now: () => 1000 });
  return { orchestrator, store, calls, events };
}

async function until(check) {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), "the condition never held");
}

async function settled(orchestrator, taskId) {
  for (let i = 0; i < 50 && orchestrator.isStarting(taskId); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a sent prompt starts a hidden task Chat in the routed Project on the least used account", async (t) => {
  const { orchestrator, store, calls } = setup(t, {
    reply: { project: "/p/happiergym", role: "build", title: "Fix the rest timer", reason: "Mentions the gym app", confidence: 0.9 },
  });
  const task = await orchestrator.send("the rest timer in my gym app skips when locked", { permissionMode: "full" });
  await settled(orchestrator, task.id);
  const saved = store.task(task.id);
  assert.equal(saved.state, "started");
  assert.equal(calls.sent[0].permissionMode, "full", "the task Chat starts in the sender's default permission mode");
  assert.equal(saved.projectPath, "/p/happiergym");
  assert.equal(saved.sessionId, 7);
  assert.equal(saved.accountId, "personal");
  assert.equal(calls.emptyChats[0].options.orchestrator.hidden, true);
  assert.deepEqual(calls.emptyChats[0].options.orchestrator.accounts, { claude: "personal" });
  assert.equal(calls.sent[0].provider, "claude");
  assert.equal(calls.sent[0].model, "claude-opus-5-5");
  assert.equal(calls.sent[0].worktreeId, "wt-1");
});

test("with no matching Project the task waits for the owner, then starts where they pick", async (t) => {
  const { orchestrator, store, calls } = setup(t, {
    reply: { project: null, role: "build", title: "Write a poem", reason: "Nothing matched", confidence: 0.2 },
  });
  const task = await orchestrator.send("write me a poem about deploys");
  await settled(orchestrator, task.id);
  assert.equal(store.task(task.id).state, "needs-project");
  assert.equal(calls.sent.length, 0);
  assert.equal((await orchestrator.pickProject(task.id, "/p/rdfood")).state, "routing", "picking returns at once");
  await until(() => store.task(task.id).state === "started");
  assert.equal(store.task(task.id).projectPath, "/p/rdfood");
  assert.equal(store.read().memory.trust.project.corrected, 1, "picking the Project is a correction the memory learns");
});

test("sending is refused while the Orchestrator is off", async (t) => {
  const { orchestrator } = setup(t, { enabled: false });
  await assert.rejects(() => orchestrator.send("anything"), /Church/);
});

test("moving to the sidebar clears the hidden flag; undo stops and archives the Chat", async (t) => {
  const { orchestrator, store, calls } = setup(t, {
    reply: { project: "/p/rdfood", role: "security", title: "Audit login", reason: "rdfood auth", confidence: 0.9 },
  });
  const task = await orchestrator.send("audit rdfood login for token leaks");
  await settled(orchestrator, task.id);
  await orchestrator.showInSidebar(task.id, true);
  assert.deepEqual(calls.hidden, [{ projectPath: "/p/rdfood", sessionId: 7, hidden: false }]);
  await orchestrator.undo(task.id);
  assert.deepEqual(calls.stopped, ["/p/rdfood#7"]);
  assert.deepEqual(calls.archived, [{ projectPath: "/p/rdfood", sessionId: 7 }]);
  assert.equal(store.task(task.id), null);
});

test("the router falls back to keywords when the model is unavailable or vague", async () => {
  const projects = [
    { path: "/p/happiergym", name: "happiergym", hints: "gym app with a rest timer" },
    { path: "/p/rdfood", name: "rdfood", hints: "restaurant ordering" },
  ];
  const roles = normalizeOrchestratorSettings(null).roles;
  const none = await routeTask({ prompt: "the rest timer is broken", projects, roles, call: null });
  assert.equal(none.projectPath, "/p/happiergym");
  assert.equal(none.by, "keywords");
  const broken = await routeTask({ prompt: "the rest timer is broken", projects, roles, call: async () => "not json" });
  assert.equal(broken.by, "keywords");
  const invented = await routeTask({
    prompt: "the rest timer is broken",
    projects,
    roles,
    call: async () => JSON.stringify({ project: "/p/elsewhere", role: "build", title: "x", reason: "y", confidence: 0.3 }),
  });
  assert.equal(invented.projectPath, "/p/happiergym", "a Project outside the list is ignored");
});

test("a task goes to the paired computer with the most room when its Project is there too", async (t) => {
  const invoked = [];
  const remote = {
    enabled: () => true,
    list: () => [{ id: "studio-id", name: "Studio" }],
    invoke: async (id, method, args) => {
      invoked.push([id, method, args]);
      if (method === "orchestrator:read")
        return {
          tasks: [
            {
              id: "remote-task",
              state: "started",
              projectPath: "/Users/s/happiergym",
              sessionId: 3,
              title: "Fix the rest timer",
              model: "claude-opus-5-5",
              reason: { project: "x" },
            },
          ],
        };
      if (method === "orchestrator:capacity")
        return {
          cpu: 0.1,
          memoryFree: 0.8,
          agents: 0,
          projects: [{ path: "/Users/s/happiergym", name: "happiergym", origin: "git@github.com:me/happiergym" }],
        };
      return { id: "remote-task", state: "routing" };
    },
  };
  const { orchestrator, store, calls } = setup(t, {
    remote,
    reply: { project: "/p/happiergym", role: "build", title: "Fix the rest timer", reason: "Mentions the gym app", confidence: 0.9 },
  });
  const task = await orchestrator.send("the rest timer in my gym app skips");
  await until(() => store.task(task.id).sessionId === 3);
  const saved = store.task(task.id);
  assert.equal(saved.computer, "Studio");
  assert.equal(saved.state, "started");
  assert.equal(saved.model, "claude-opus-5-5");
  assert.equal(saved.remoteTaskId, "remote-task");
  assert.equal(saved.projectPath, "/Users/s/happiergym");
  assert.match(saved.reason.computer, /Studio has the most room/);
  assert.equal(calls.sent.length, 0, "nothing started on this computer");
  assert.ok(invoked.some(([, method]) => method === "orchestrator:start-here"));
  await orchestrator.undo(task.id);
  assert.deepEqual(invoked.at(-1), ["studio-id", "orchestrator:task:undo", ["remote-task"]]);
});

test("with a single Project it starts there instead of asking", async (t) => {
  const { orchestrator, store, calls } = setup(t, {
    reply: { project: null, role: "build", title: "Explain notes", reason: "Nothing matched", confidence: 0.2 },
  });
  const only = PROJECTS.splice(1);
  t.after(() => PROJECTS.push(...only));
  const task = await orchestrator.send("explain what notes.txt in this repo is for");
  await settled(orchestrator, task.id);
  assert.equal(store.task(task.id).state, "started");
  assert.equal(store.task(task.id).projectPath, "/p/happiergym");
  assert.equal(calls.sent.length, 1);
});

test("a paired computer on an older Milagre shows online with its memory, but can't take tasks", async (t) => {
  const remote = {
    enabled: () => true,
    list: () => [
      { id: "old", name: "Old Mac", online: true },
      { id: "away", name: "Away", online: false },
    ],
    invoke: async (id, method) => {
      if (method === "computer:resources:read") return { memory: { total: 100, available: 25 } };
      throw new Error(`unknown command ${method}`);
    },
  };
  const { orchestrator } = setup(t, { remote });
  const [old, away] = await orchestrator.computers();
  assert.deepEqual(old, { id: "old", name: "Old Mac", online: true, cpu: null, memoryFree: 0.25, agents: null, takesTasks: false });
  assert.equal(away.online, false);
});
