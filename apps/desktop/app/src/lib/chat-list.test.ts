import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, ChatMessage } from "../model";
import { chatMark, dropIntent, folderName, formatLineCount, isChatListed, orderChats } from "./chat-list.ts";
import { createPendingChat, withPendingChat } from "@milagre/shared/chats";
import type { CoordinatorState } from "../model";

test("chatMark: a question beats waiting beats running beats unread", () => {
  assert.equal(chatMark({ asking: true, waiting: true, running: true, unread: true }), "question");
  assert.equal(chatMark({ waiting: true, running: true, unread: true }), "waiting");
  assert.equal(chatMark({ waiting: false, running: true, unread: true }), "running");
  assert.equal(chatMark({ waiting: false, running: false, unread: true }), "unread");
  assert.equal(chatMark({ waiting: false, running: false, unread: false }), "idle");
});

test("chatMark: a Delegation working in the chat shows over running, under anything that waits on the user", () => {
  assert.equal(chatMark({ waiting: false, delegated: true, running: true, unread: true }), "delegated");
  assert.equal(chatMark({ waiting: true, delegated: true, running: true, unread: false }), "waiting");
});

test("formatLineCount and folderName", () => {
  assert.equal(formatLineCount(0), "0");
  assert.equal(formatLineCount(980), "980");
  assert.equal(formatLineCount(1000), "1k");
  assert.equal(formatLineCount(2140), "2.1k");
  assert.equal(formatLineCount(14_400), "14k");
  assert.equal(formatLineCount(2_100_000), "2.1m");
  assert.equal(folderName("/Users/v/.milagre/worktrees/app/fix-login-ab12/"), "fix-login-ab12");
  assert.equal(folderName("/"), "/");
});

test("orderChats sorts newest first by start, or by latest message", () => {
  const chat = (name: string, ids: number[]) => ({
    name,
    session: {},
    sessionMessages: ids.map((id) => ({ id, session_id: 1, body: "", context: null })) as ChatMessage[],
  });
  const chats = [chat("old but active", [1, 9]), chat("newest", [7, 8]), chat("middle", [4, 5])];
  assert.deepEqual(
    orderChats(chats, "created").map((c) => c.name),
    ["newest", "middle", "old but active"],
  );
  assert.deepEqual(
    orderChats(chats, "recent").map((c) => c.name),
    ["old but active", "newest", "middle"],
  );
  assert.deepEqual(
    chats.map((c) => c.name),
    ["old but active", "newest", "middle"],
  );
});

test("orderChats keeps pinned chats on top in their own order, whatever their activity", () => {
  const chat = (name: string, ids: number[], session = {}) => ({
    name,
    session,
    sessionMessages: ids.map((id) => ({ id, session_id: 1, body: "", context: null })) as ChatMessage[],
  });
  const chats = [
    chat("busy", [1, 99]),
    chat("second pin", [2], { pinned: true, pin_order: 1 }),
    chat("first pin", [3, 98], { pinned: true, pin_order: 0 }),
    chat("quiet", [4]),
  ];
  assert.deepEqual(
    orderChats(chats, "recent").map((c) => c.name),
    ["first pin", "second pin", "busy", "quiet"],
  );
  assert.deepEqual(
    orderChats(chats, "created").map((c) => c.name),
    ["first pin", "second pin", "quiet", "busy"],
  );
});

test("sending to a Chat without loaded messages follows the chosen order until it is saved", () => {
  const state = {
    next_id: 100,
    projects: {},
    worktrees: {},
    messages: [],
    tasks: {},
    sessions: {
      1: { id: 1, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 8, firstId: 3, lastId: 40 } },
      10: { id: 10, worktree_id: 1, agent_name: "Claude", status: "Idle", summary: { count: 2, firstId: 12, lastId: 60 } },
    },
  } as CoordinatorState;
  const pending = createPendingChat({ state, worktreeId: 1, sessionId: 1, body: "Follow up", model: "m", provider: "claude" });
  const preview = withPendingChat(state, pending);
  const saved = { ...state, sessions: { ...state.sessions, 1: { ...state.sessions[1], summary: { count: 9, firstId: 3, lastId: 100 } } } };
  for (const current of [preview, saved]) {
    const chats = Object.values(current.sessions).map((session) => ({ session, sessionMessages: [] }));
    assert.deepEqual(
      orderChats(chats, "created").map(({ session }) => session.id),
      [10, 1],
    );
    assert.deepEqual(
      orderChats(chats, "recent").map(({ session }) => session.id),
      [1, 10],
    );
  }
});

test("dropIntent: between rows pins, unpins or reorders; on a row links other Worktrees", () => {
  const pinned = { pinned: true, worktree: "/a" };
  const recent = { worktree: "/b" };
  assert.equal(dropIntent(recent, null, "before"), "pin");
  assert.equal(dropIntent(pinned, null, "before"), "none");
  assert.equal(dropIntent(recent, pinned, "after"), "pin");
  assert.equal(dropIntent(pinned, { pinned: true, worktree: "/c" }, "before"), "reorder");
  assert.equal(dropIntent(pinned, recent, "before"), "unpin");
  assert.equal(dropIntent(recent, { worktree: "/c" }, "after"), "none");
  assert.equal(dropIntent(recent, pinned, "on"), "link");
  assert.deepEqual(dropIntent(recent, pinned, "on", true), { invalid: "linked" });
  assert.deepEqual(dropIntent(recent, { worktree: "/b" }, "on"), { invalid: "same-worktree" });
});

test("isChatListed: a Chat needs a message, and a hidden Run Chat is listed only while it waits on the user", () => {
  const message = (id: number) => ({ id, session_id: 1, body: "Result", context: null, role: "assistant" }) as ChatMessage;
  const plain = { id: 1 } as AgentSession;
  const hidden = { id: 2, routine: { routineId: "r", runId: "u", hidden: true } } as AgentSession;
  const kept = { id: 3, routine: { routineId: "r", runId: "u", hidden: false } } as AgentSession;
  assert.equal(isChatListed(plain, [message(1)], false), true);
  assert.equal(isChatListed(plain, [], false), false);
  assert.equal(isChatListed(hidden, [message(1)], false), false);
  assert.equal(isChatListed(hidden, [message(1)], true), true);
  assert.equal(isChatListed(kept, [message(1)], false), true);
  // Waiting doesn't list a Chat that has nothing to show.
  assert.equal(isChatListed(hidden, [], true), false);
});
