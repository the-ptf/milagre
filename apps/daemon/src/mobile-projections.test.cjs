const { test } = require("node:test");
const assert = require("node:assert/strict");
const { forPhone, forChatList, phoneSession, phoneMessage } = require("./mobile-projections.cjs");
const { phoneReply } = require("./mobile-routes.cjs");

const session = {
  id: 1,
  title: "Fix the build",
  provider: "codex",
  model: "gpt-5",
  permissionMode: "auto",
  worktree_id: 2,
  pinned: true,
  done_at: 10,
  snoozed_until: 20,
  unread: true,
  parentChat: "/p#3",
  routine: { runId: "r1", hidden: false },
  summary: { count: 2, lastAt: 5, pullRequests: ["#7"] },
  subagents: [{ id: "a", status: "done", latestActivity: "x".repeat(900), transcript: [{ text: "t" }], extra: "kept" }],
  someFutureField: { nested: true },
};
const message = {
  id: 9,
  session_id: 1,
  role: "assistant",
  body: "done",
  outcome: "ok",
  clientMessageId: "c1",
  steps: [{ kind: "tool", title: "Read", detail: "long" }],
};
const project = {
  path: "/p",
  name: "p",
  kind: "chats",
  someProjectField: 1,
  state: { sessions: { 1: session }, messages: [message], worktrees: { 2: { id: 2, path: "/w" } }, tasks: { 1: [] }, someStateField: "kept" },
};

test("forPhone keeps every Project, state and session field and only slims step details and subagent transcripts", () => {
  const slim = forPhone(project);
  for (const key of Object.keys(project)) if (key !== "state") assert.deepEqual(slim[key], project[key], key);
  for (const key of Object.keys(project.state)) if (key !== "messages" && key !== "sessions") assert.deepEqual(slim.state[key], project.state[key], key);
  const phone = slim.state.sessions[1];
  for (const key of Object.keys(session)) if (key !== "subagents") assert.deepEqual(phone[key], session[key], key);
  assert.equal(phone.subagents[0].extra, "kept");
  assert.equal(phone.subagents[0].status, "done");
  assert.ok(phone.subagents[0].latestActivity.length < session.subagents[0].latestActivity.length);
  assert.deepEqual(slim.pullRequestRefs, { 1: ["#7"] });
  const step = slim.state.messages[0].steps[0];
  assert.equal(step.detail, undefined);
  assert.equal(step.hasDetail, true);
  assert.equal(slim.state.messages[0].body, "done");
});

test("phoneSession and phoneMessage return the same object when there is nothing to slim", () => {
  const plain = { ...session, subagents: [] };
  assert.equal(phoneSession(plain), plain);
  const quiet = { ...message, steps: [{ kind: "tool", title: "Read" }] };
  assert.equal(phoneMessage(quiet), quiet);
});

test("forChatList keeps every session field but subagents, and each message's identity and outcome", () => {
  const list = forChatList(project, { seq: 3, runs: { "/p#1": { model: "m", startedAt: 1, approvals: [], questions: [], text: "hidden", steps: [1] } } });
  assert.equal(list.previewOnly, true);
  const listed = list.project.state.sessions[1];
  for (const key of Object.keys(session)) {
    if (key === "subagents") assert.equal(key in listed, false);
    else assert.deepEqual(listed[key], session[key], key);
  }
  assert.equal(list.project.state.someStateField, "kept");
  assert.deepEqual(list.project.state.messages, [{ id: 9, session_id: 1, role: "assistant", outcome: "ok", clientMessageId: "c1", body: "", context: null }]);
  assert.deepEqual(list.runs.runs["/p#1"], { model: "m", startedAt: 1, approvals: [], questions: [], answered: {}, text: "", steps: [] });
  assert.equal(list.runs.seq, 3);
});

test("phoneReply leaves out the Mac's hidden flags and keeps only what the phone reads after opening", () => {
  assert.deepEqual(phoneReply("project:recent", [{ path: "/p", hidden: true, name: "p" }, null]), [{ path: "/p", name: "p" }, null]);
  assert.deepEqual(phoneReply("link:update", { id: "l", hidden: true, name: "L" }), { id: "l", name: "L" });
  assert.deepEqual(phoneReply("project:open", { path: "/p", name: "p", kind: "chats", state: {} }), { path: "/p", name: "p", kind: "chats" });
  assert.deepEqual(phoneReply("link:open", { link: { id: "l", name: "L", state: {} } }), { id: "l", name: "L" });
  assert.deepEqual(phoneReply("chat:send", { sessionId: 4, hidden: true }), { sessionId: 4, hidden: true });
  const created = phoneReply("worktree:create", { worktreeId: 2, project: { ...project, state: { ...project.state, messagesInChats: true } } });
  assert.deepEqual(Object.keys(created.project.state.worktrees), ["2"]);
  assert.deepEqual(created.project.state.messages, []);
  assert.equal("messagesInChats" in created.project.state, false);
});
