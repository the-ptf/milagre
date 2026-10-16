import assert from "node:assert/strict";
import test from "node:test";
import { activityOf, backgroundLabel, backgroundSubagents, chatActivity, createActivityTracker } from "./chat-activity.mjs";

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

test("backgroundLabel", () => {
  assert.equal(backgroundLabel(1), "1 background agent");
  assert.equal(backgroundLabel(3), "3 background agents");
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

test("tracker: requests make a turn waiting until they are answered or the turn ends", () => {
  const tracker = createActivityTracker();
  tracker.observe("c", { type: "turn-started" });
  assert.equal(tracker.observe("c", { type: "permission-request", requestId: "p" }).next, "waiting");
  assert.equal(tracker.observe("c", { type: "permission-resolved", requestId: "p" }).next, "working");
  tracker.observe("c", { type: "question-request", requestId: "q" });
  assert.equal(tracker.observe("c", { type: "turn-completed" }).next, "idle");
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
