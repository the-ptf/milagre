import assert from "node:assert/strict";
import test from "node:test";
import {
  activityOf,
  backgroundBusyMessage,
  backgroundItems,
  backgroundLabel,
  backgroundSubagents,
  backgroundTasks,
  chatActivity,
  createActivityTracker,
  plainTaskOutput,
  processWork,
} from "./chat-activity.mjs";

const run = (patch = {}) => ({ text: "", model: "m", steps: [], approvals: [], questions: [], answered: {}, ...patch });
const agent = (id, patch = {}) => ({ id, title: id, status: "running", startedAt: 10, updatedAt: 10, transcript: [], ...patch });
const session = (patch = {}) => ({ id: 1, provider: "claude", subagents: [], ...patch });

test("activityOf: waiting, then working, then failed, then background, then idle", () => {
  assert.equal(activityOf({ running: true, waiting: true, failed: true, background: 2 }), "waiting");
  assert.equal(activityOf({ running: true, failed: true, background: 2 }), "working");
  assert.equal(activityOf({ failed: true, background: 2 }), "failed");
  assert.equal(activityOf({ background: 2 }), "background");
  assert.equal(activityOf({}), "idle");
  // Only a running turn can wait on the user.
  assert.equal(activityOf({ waiting: true }), "idle");
});

test("chatActivity counts the background subagents still at work, oldest first", () => {
  const chat = session({
    native_session_id: "parent",
    subagents: [
      agent("late", { background: true, startedAt: 30 }),
      agent("early", { background: true, startedAt: 20, status: "waiting" }),
      agent("done", { background: true, status: "completed" }),
      agent("foreground"),
      agent("parent", { background: true }),
    ],
  });
  assert.deepEqual(
    backgroundSubagents(chat).map((child) => child.id),
    ["early", "late"],
  );
  assert.deepEqual(chatActivity(chat, undefined), { activity: "background", background: 2, since: 20 });
  assert.deepEqual(chatActivity(chat, run()), { activity: "working", background: 2, since: 20 });
  assert.deepEqual(chatActivity(chat, run({ questions: [{ requestId: "q" }] })).activity, "waiting");
  assert.deepEqual(chatActivity(session(), undefined), { activity: "idle", background: 0 });
});

test("chatActivity: a failed last turn wins over background work", () => {
  const chat = session({ summary: { lastOutcome: "failed" }, subagents: [agent("bg", { background: true })] });
  assert.deepEqual(chatActivity(chat, undefined), { activity: "failed", background: 1, since: 10 });
  // A new turn is work again, and the summary given explicitly (an older host keeps none) counts the same.
  assert.equal(chatActivity(chat, run()).activity, "working");
  assert.equal(chatActivity(session({ subagents: chat.subagents }), undefined, "failed").activity, "failed");
  assert.equal(chatActivity(session({ summary: { lastOutcome: "cancelled" }, subagents: chat.subagents }), undefined).activity, "background");
});

test("chatActivity tracks background work only for providers that have it", () => {
  const subagents = [agent("bg", { background: true })];
  assert.equal(chatActivity(session({ provider: "codex", subagents }), undefined).activity, "idle");
  assert.equal(chatActivity(session({ provider: "antigravity", subagents }), undefined).activity, "idle");
  // A Chat saved before providers were recorded runs on Claude.
  assert.equal(chatActivity(session({ provider: undefined, subagents }), undefined).activity, "background");
});

test("a running advisor is background work on any provider, but not a subagent its agent process holds", () => {
  const chat = session({ provider: "codex", subagents: [agent("advisor", { source: "milagre-advisor", provider: "claude" })] });
  assert.deepEqual(chatActivity(chat, undefined), { activity: "background", background: 1, since: 10 });
  assert.deepEqual(backgroundSubagents(chat), []);
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-completed" });
  assert.equal(tracker.observe("c", { type: "subagent-update", agent: chat.subagents[0] }).next, "background");
});

test("background tasks the agent process reports count as background work, after its subagents", () => {
  const task = (id, kind, startedAt) => ({ id, kind, title: id, startedAt });
  const chat = session({
    subagents: [agent("bg", { background: true, startedAt: 30 })],
    backgroundTasks: [task("shell", "local_bash", 20), task("mcp", "mcp_task", 40)],
  });
  assert.deepEqual(chatActivity(chat, undefined), { activity: "background", background: 3, since: 20 });
  assert.deepEqual(
    processWork(chat).map((item) => item.id),
    ["shell", "bg", "mcp"],
  );
  assert.deepEqual(
    backgroundTasks(chat).map((item) => item.id),
    ["shell", "mcp"],
  );
  // A Codex Chat's process reports none; a saved set from a Claude turn before a switch doesn't count.
  assert.deepEqual(backgroundTasks({ ...chat, provider: "codex" }), []);
  assert.equal(chatActivity(session({ backgroundTasks: [task("shell", "local_bash", 1)], summary: { lastOutcome: "failed" } }), undefined).activity, "failed");
});

test("backgroundItems lists the background line's work oldest first, with what each is", () => {
  const task = (id, kind, startedAt) => ({ id, kind, title: `${id} title`, startedAt });
  const chat = session({
    provider: "claude",
    subagents: [agent("bg", { background: true, startedAt: 30 }), agent("advisor", { source: "milagre-advisor", startedAt: 50 }), agent("foreground")],
    backgroundTasks: [task("shell", "local_bash", 20), task("flow", "local_workflow", 40), task("mcp", "mcp_task", 60)],
  });
  const items = backgroundItems(chat);
  assert.deepEqual(
    items.map(({ type, id, title, startedAt }) => ({ type, id, title, startedAt })),
    [
      { type: "command", id: "shell", title: "shell title", startedAt: 20 },
      { type: "subagent", id: "bg", title: "bg", startedAt: 30 },
      { type: "workflow", id: "flow", title: "flow title", startedAt: 40 },
      { type: "advisor", id: "advisor", title: "advisor", startedAt: 50 },
      { type: "task", id: "mcp", title: "mcp title", startedAt: 60 },
    ],
  );
  // A subagent or advisor carries itself, for its transcript; a task has none.
  assert.equal(items[1].agent, chat.subagents[0]);
  assert.equal(items[0].agent, undefined);
  // The line counts what it lists.
  assert.equal(items.length, chatActivity(chat, undefined).background);
});

test("plainTaskOutput drops escape sequences and keeps a redrawn line's last state", () => {
  assert.equal(plainTaskOutput("\u001b[32m✓\u001b[0m build\r\n"), "✓ build\n");
  assert.equal(plainTaskOutput("\u001b]0;title\u0007 10%\r 50%\r100% done\nnext"), "100% done\nnext");
  assert.equal(plainTaskOutput("\u001b[2K\u001b[1Gwaiting\u001b(B"), "waiting");
  assert.equal(plainTaskOutput(undefined), "");
});

test("backgroundLabel and the guard's message", () => {
  assert.equal(backgroundLabel(1), "1 background task");
  assert.equal(backgroundLabel(3), "3 background tasks");
  assert.equal(
    backgroundBusyMessage("switch", 1, "Codex"),
    "A background task is still running in this Chat. Switching to Codex would stop it. Ask the agent to stop it, or send again once it finishes.",
  );
  assert.equal(
    backgroundBusyMessage("reload", 2),
    "2 background tasks are still running in this Chat. Reloading would stop them. Ask the agent to stop them, or reload once they finish.",
  );
  assert.match(backgroundBusyMessage("move", 1), /can't move to another folder without stopping it/);
});

const bg = (id, status = "running") => ({ type: "subagent-update", agent: agent(id, { background: true, status }) });

test("tracker: a plain turn announces its end with the reply's start", () => {
  const tracker = createActivityTracker();
  assert.deepEqual(tracker.observe("c", { type: "turn-started", turnId: "t" }), { previous: "idle", next: "working", completion: null });
  tracker.observe("c", { type: "text-delta", text: "Done ", messageId: "m" });
  tracker.observe("c", { type: "text-delta", text: "here.", messageId: "m" });
  const end = tracker.observe("c", { type: "turn-completed" });
  assert.equal(end.next, "idle");
  assert.deepEqual({ failed: end.completion.failed, body: end.completion.body }, { failed: false, body: "Done here." });
  assert.equal(tracker.observe("c", { type: "turn-completed" }).completion, null);
});

test("tracker: a turn that ends while background agents work announces once, when the last one ends", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  tracker.observe("c", bg("b"));
  tracker.observe("c", { type: "text-delta", text: "Started two agents.", messageId: "m" });
  const end = tracker.observe("c", { type: "turn-completed" });
  assert.deepEqual([end.next, end.completion], ["background", null]);
  assert.equal(tracker.background("c"), 2);
  assert.equal(tracker.observe("c", bg("a", "completed")).completion, null);
  assert.equal(tracker.activity("c"), "background");
  const last = tracker.observe("c", bg("b", "completed"));
  assert.deepEqual([last.previous, last.next, last.completion?.body], ["background", "idle", "Started two agents."]);
});

test("tracker: the turn a background result wakes announces its own end, and the held one is dropped", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  tracker.observe("c", { type: "text-delta", text: "Started.", messageId: "1" });
  tracker.observe("c", { type: "turn-completed" });
  // Claude starts the woken turn before it reports the agent done (claude-provider.cjs beginImplicitTurn).
  assert.deepEqual(tracker.observe("c", { type: "turn-started" }), { previous: "background", next: "working", completion: null });
  assert.equal(tracker.observe("c", bg("a", "completed")).completion, null);
  tracker.observe("c", { type: "text-delta", text: "The agent reported back.", messageId: "2" });
  const end = tracker.observe("c", { type: "turn-completed" });
  assert.equal(end.completion?.body, "The agent reported back.");
});

test("tracker: a failure wins over background work and is announced at once", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  const end = tracker.observe("c", { type: "turn-failed", message: "Out of credits" });
  assert.deepEqual([end.next, end.completion?.failed, end.completion?.body], ["failed", true, "Out of credits"]);
  // The background agent ending later changes nothing more.
  assert.deepEqual(tracker.observe("c", bg("a", "completed")), { previous: "failed", next: "failed", completion: null });
});

test("tracker: a cancelled turn announces nothing, now or when its background agents end", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  assert.equal(tracker.observe("c", { type: "turn-cancelled" }).completion, null);
  assert.equal(tracker.observe("c", bg("a", "cancelled")).completion, null);
  assert.equal(tracker.activity("c"), "idle");
});

test("tracker: a quiet turn (a heartbeat's pass, or one failing again) announces nothing, now or later", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", { type: "text-delta", text: "(pass) nothing new" });
  const pass = tracker.observe("c", { type: "turn-completed", quiet: true });
  assert.deepEqual([pass.next, pass.completion], ["idle", null]);
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  assert.equal(tracker.observe("c", { type: "turn-failed", message: "Out of credits", quiet: true }).completion, null);
  assert.equal(tracker.observe("c", bg("a", "completed")).completion, null);
  // The next ordinary turn still announces its end.
  tracker.observe("c", { type: "turn-started" });
  assert.equal(tracker.observe("c", { type: "turn-completed" }).completion?.body, "Turn completed.");
});

test("tracker: a quiet turn that ends while background agents work announces nothing when the last one ends either", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", bg("a"));
  const end = tracker.observe("c", { type: "turn-completed", quiet: true });
  assert.deepEqual([end.next, end.completion], ["background", null]);
  const done = tracker.observe("c", bg("a", "completed"));
  assert.deepEqual([done.previous, done.next, done.completion], ["background", "idle", null]);
});

test("tracker: requests make a turn waiting until they are answered or the turn ends", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  assert.equal(tracker.observe("c", { type: "permission-request", requestId: "p" }).next, "waiting");
  assert.equal(tracker.observe("c", { type: "permission-resolved", requestId: "p" }).next, "working");
  tracker.observe("c", { type: "question-request", requestId: "q" });
  assert.equal(tracker.observe("c", { type: "turn-completed" }).next, "idle");
});

test("tracker: a background command doesn't hold the turn's announcement; an MCP task does", () => {
  const tracker = createActivityTracker();
  const tasks = (...list) => ({ type: "background-tasks", tasks: list.map(([id, kind]) => ({ id, kind, title: id, startedAt: 1 })) });
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", tasks(["server", "local_bash"]));
  tracker.observe("c", { type: "text-delta", text: "The dev server runs.", messageId: "m" });
  // A server can run for hours: the turn's end is announced at once.
  assert.equal(tracker.observe("c", { type: "turn-completed" }).completion?.body, "The dev server runs.");
  tracker.observe("c", { type: "turn-started" });
  tracker.observe("c", tasks(["server", "local_bash"], ["export", "mcp_task"]));
  tracker.observe("c", { type: "text-delta", text: "Exporting.", messageId: "m" });
  const held = tracker.observe("c", { type: "turn-completed" });
  assert.deepEqual([held.next, held.completion, tracker.background("c")], ["background", null, 1]);
  const done = tracker.observe("c", tasks(["server", "local_bash"]));
  assert.deepEqual([done.next, done.completion?.body], ["idle", "Exporting."]);
});

test("tracker: forget and its cap", () => {
  const tracker = createActivityTracker({ maxChats: 2 });
  tracker.observe("a", { type: "turn-started" });
  tracker.observe("b", { type: "turn-started" });
  tracker.observe("c", { type: "turn-started" });
  assert.equal(tracker.activity("a"), "idle");
  tracker.forget((chatId) => chatId === "b");
  assert.deepEqual([tracker.activity("b"), tracker.activity("c")], ["idle", "working"]);
  tracker.forget();
  assert.equal(tracker.activity("c"), "idle");
});
