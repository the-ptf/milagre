import assert from "node:assert/strict";
import test from "node:test";
import { createPendingChat } from "@milagre/shared/chats";
import type { CoordinatorState } from "../model";
import { NO_WORKTREE, sendPendingReducer, shownPendingSend, withSendPreviews, type FailedSend, type PendingSend } from "./send-pending.ts";

function projectState(messages: CoordinatorState["messages"] = []): CoordinatorState {
  return {
    sessions: { 1: { id: 1, worktree_id: 7, agent_name: "One", status: "Idle" } },
    worktrees: { 7: { id: 7, name: "main", path: "/p" } },
    messages,
    next_id: 100,
  } as unknown as CoordinatorState;
}

function pending(body: string, overrides: Partial<PendingSend> = {}): PendingSend {
  const preview = createPendingChat({ state: projectState(), worktreeId: NO_WORKTREE, body, clientMessageId: `id-${body}` });
  return { ...preview, view: 1, projectPath: "/p", originSessionId: null, originWorktreeId: 7, creatingWorktree: true, ...overrides };
}

test("a send moves from preview to its target Chat, to sent, and goes when the host's state holds it", () => {
  const send = pending("hi");
  let list = sendPendingReducer([], { type: "add", send });
  assert.deepEqual(list, [send]);

  list = sendPendingReducer(list, { type: "target", clientMessageId: "id-hi", sessionId: 5, worktreeId: 9 });
  assert.equal(list[0].creatingWorktree, false);
  assert.equal(list[0].targetSessionId, 5);
  assert.equal(list[0].session.worktree_id, 9);

  list = sendPendingReducer(list, { type: "sent", clientMessageId: "id-hi", sessionId: 5, worktreeId: 9 });
  assert.equal(list[0].sent, true);
  assert.equal(list[0].originSessionId, 5);
  assert.equal(list[0].originWorktreeId, 9);

  const before = list;
  assert.equal(sendPendingReducer(list, { type: "prune", states: { "/p": projectState() } }), before, "a saved message not in the state yet keeps the preview");
  assert.deepEqual(sendPendingReducer(list, { type: "prune", states: {} }), [], "a Project the window holds no state for drops it");
  const saved = projectState([{ id: 3, session_id: 5, role: "user", body: "hi", clientMessageId: "id-hi" } as never]);
  assert.deepEqual(sendPendingReducer(list, { type: "prune", states: { "/p": saved } }), []);
});

test("an unsent preview survives a prune, and a failed one drops by its id only", () => {
  const a = pending("a");
  const b = pending("b");
  const list = [a, b];
  assert.equal(sendPendingReducer(list, { type: "prune", states: { "/p": projectState() } }), list);
  assert.deepEqual(sendPendingReducer(list, { type: "drop", clientMessageId: "id-a" }), [b]);
  assert.deepEqual(sendPendingReducer(list, { type: "target", clientMessageId: "id-x", sessionId: 1, worktreeId: 7 }), list);
});

test("the open Chat shows the latest send from its view, from itself, or that became it", () => {
  const state = projectState();
  const fromView = pending("view", { view: 2 });
  const fromChat = pending("chat", { view: 9, originSessionId: 1 });
  const elsewhere = pending("other", { view: 3, projectPath: "/q" });
  const list = [fromView, fromChat, elsewhere];
  assert.equal(shownPendingSend(list, { project: { path: "/p" }, view: 2, session: undefined, state }), fromView);
  assert.equal(shownPendingSend(list, { project: { path: "/p" }, view: 2, session: { id: 1 }, state }), fromChat);
  assert.equal(shownPendingSend(list, { project: { path: "/q" }, view: 2, session: undefined, state }), undefined);
  assert.equal(shownPendingSend(list, { project: null, view: 3, session: undefined, state }), undefined);
});

test("the sidebar's state carries the open Project's failed and pending previews only", () => {
  const state = projectState();
  const failed: FailedSend = { ...pending("lost"), draft: "lost", error: "offline", target: null };
  const next = withSendPreviews(state, "/p", [pending("new"), pending("there", { projectPath: "/q" })], [failed]);
  assert.deepEqual(
    next.messages.map((message) => message.body),
    ["lost", "new"],
  );
  assert.equal(withSendPreviews(state, "/p", [], []), state);
});
