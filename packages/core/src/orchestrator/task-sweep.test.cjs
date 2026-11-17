const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrchestratorStore } = require("./store.cjs");
const { createTaskSweep } = require("./task-sweep.cjs");

const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

function setup(t, { tasks, sessions = {}, held = ["/p/a"], busy = [], retentionHours = 24, remoteTasks = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-task-sweep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestratorStore({ file: path.join(dir, "orchestrator.json") });
  store.update((current) => ({ ...current, tasks: tasks.map((task) => ({ prompt: "do it", state: "started", projectPath: "/p/a", ...task })) }));
  const archived = [];
  const dropped = [];
  const sweep = createTaskSweep({
    store,
    now: () => NOW,
    ports: {
      doneSettings: () => ({ retentionHours }),
      busy: () => new Set(busy),
      heldState: (projectPath) => (held.includes(projectPath) ? { sessions } : undefined),
      chatKey: (projectPath, sessionId) => `${projectPath}#${sessionId}`,
      archive: async (projectPath, sessionId) => archived.push(`${projectPath}#${sessionId}`),
      images: { drop: (id) => dropped.push(id) },
      remote: {
        enabled: () => true,
        invoke: async (computerId, method) => {
          assert.equal(method, "orchestrator:read");
          if (!(computerId in remoteTasks)) throw new Error("offline");
          return { tasks: remoteTasks[computerId].map((id) => ({ id })) };
        },
      },
      withTimeout: (promise) => promise,
    },
  });
  const left = () => store.read().tasks.map((task) => task.id);
  return { sweep, archived, dropped, left };
}

const finished = (lastAt) => ({ summary: { lastOutcome: "completed", lastAt }, orchestrator: { hidden: true } });

test("tasks leave the board on the sidebar's Done clock, and their hidden Chats are archived", async (t) => {
  const { sweep, archived, dropped, left } = setup(t, {
    tasks: [
      { id: "marked", sessionId: 1 },
      { id: "fresh-mark", sessionId: 2 },
      { id: "idle-hidden", sessionId: 3 },
      { id: "idle-shown", sessionId: 4 },
      { id: "working", sessionId: 5 },
      { id: "archived", sessionId: 6 },
      { id: "deleted", sessionId: 7 },
      { id: "routing", state: "routing", sessionId: null, projectPath: null },
      { id: "unloaded", sessionId: 1, projectPath: "/p/b" },
    ],
    sessions: {
      1: { done_at: NOW - 24 * HOUR, orchestrator: { hidden: true } },
      2: { done_at: NOW - HOUR, orchestrator: { hidden: true } },
      3: finished(NOW - 25 * HOUR),
      4: { ...finished(NOW - 25 * HOUR), orchestrator: { hidden: false } },
      5: finished(NOW - 25 * HOUR),
      6: { archived: true },
    },
    busy: ["/p/a#5"],
  });
  assert.deepEqual((await sweep.sweep()).sort(), ["archived", "deleted", "idle-hidden", "idle-shown", "marked"]);
  assert.deepEqual(left(), ["fresh-mark", "working", "routing", "unloaded"]);
  assert.deepEqual(archived, ["/p/a#3"], "only the hidden idle Chat is archived here; the Done sweep archives marked ones");
  assert.deepEqual(dropped.sort(), ["archived", "deleted", "idle-hidden", "idle-shown", "marked"]);
});

test("Never keeps Done tasks but still drops ones whose Chat is gone", async (t) => {
  const { sweep, left } = setup(t, {
    retentionHours: 0,
    tasks: [
      { id: "marked", sessionId: 1 },
      { id: "archived", sessionId: 2 },
    ],
    sessions: { 1: { done_at: 1 }, 2: { archived: true } },
  });
  assert.deepEqual(await sweep.sweep(), ["archived"]);
  assert.deepEqual(left(), ["marked"]);
});

test("a task placed on another computer leaves once that computer's board dropped it, and stays while it's offline", async (t) => {
  const { sweep, left } = setup(t, {
    tasks: [
      { id: "kept", remoteComputerId: "studio", remoteTaskId: "r1", sessionId: 3 },
      { id: "swept", remoteComputerId: "studio", remoteTaskId: "r2", sessionId: 4 },
      { id: "offline", remoteComputerId: "mbp", remoteTaskId: "r3", sessionId: 5 },
    ],
    remoteTasks: { studio: ["r1"] },
  });
  assert.deepEqual(await sweep.sweep(), ["swept"]);
  assert.deepEqual(left(), ["kept", "offline"]);
});
