import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, ChatMessage, CoordinatorState } from "./model.ts";
import { chatTitle, comparePins, pinOrderAt } from "./chats.mjs";

const session: AgentSession = { id: 1, worktree_id: 1, agent_name: "main", status: "Created" };

test("chatTitle prefers the user's name, then the first message's first line", () => {
  const messages = [
    { id: 1, session_id: 1, body: "", context: null, role: "user" },
    { id: 2, session_id: 1, body: "Fix the login\nand more", context: null, role: "user" },
  ] as ChatMessage[];
  assert.equal(chatTitle(session, messages), "Fix the login");
  assert.equal(chatTitle({ ...session, title: "  Login bug " }, messages), "Login bug");
  assert.equal(chatTitle({ ...session, title: "   " }, messages), "Fix the login");
  assert.equal(chatTitle(session, []), "main");
  assert.equal(chatTitle(session, [{ id: 3, session_id: 1, body: "x".repeat(80), context: null }]), `${"x".repeat(57)}…`);
});

test("chat lists hide a worktree's empty starter chat but keep chats with messages and handovers", async () => {
  const { isListedChat } = await import("./chats.mjs");
  assert.equal(isListedChat({} as never, 0), false);
  assert.equal(isListedChat({} as never, 2), true);
  assert.equal(isListedChat({ handoverPending: true } as never, 0), true);
  assert.equal(isListedChat({ handoverDraft: "" } as never, 0), true);
});

test("pending input lists its Chat without modifying the persisted Project", async () => {
  const { createPendingChat, withPendingChat } = await import("./chats.mjs");
  const state: CoordinatorState = {
    next_id: 4,
    projects: {},
    worktrees: { 1: { id: 1, name: "main", path: "/p", project_id: 1 } },
    sessions: {},
    messages: [],
    tasks: {},
  };
  const pending = createPendingChat({ state, worktreeId: 1, body: "Fix login\nDetails", model: "gpt-6-astra", provider: "codex" });
  const shown = withPendingChat(state, pending);
  assert.equal(chatTitle(shown.sessions[pending.session.id], shown.messages), "Fix login");
  assert.equal(shown.messages[0].role, "user");
  assert.equal(shown.sessions[pending.session.id].worktree_id, 1);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.messages, []);
  assert.equal(withPendingChat(state, null), state);
});

test("canonical input replaces a pending Chat before the send response without merging identical text", async () => {
  const { createPendingChat, withPendingChat, pendingChatSessionId } = await import("./chats.mjs");
  const state: CoordinatorState = { next_id: 4, projects: {}, worktrees: {}, sessions: {}, messages: [], tasks: {} };
  const pending = createPendingChat({ state, worktreeId: 1, body: "Hello", model: "m", provider: "codex" });
  const persisted: CoordinatorState = {
    ...state,
    next_id: 8,
    sessions: { 5: { id: 5, worktree_id: 1, agent_name: "main", status: "Created" } },
    messages: [{ id: 6, session_id: 5, body: "Hello", role: "user", context: null }],
  };
  assert.equal(pendingChatSessionId(persisted, pending), null, "another client may send identical text");
  persisted.messages[0] = { ...persisted.messages[0], clientMessageId: pending.message.clientMessageId };
  assert.equal(pendingChatSessionId(persisted, pending), 5);
  assert.equal(withPendingChat(persisted, pending), persisted);
});

test("follow-up input stays pending until its own message arrives and keeps the Chat title", async () => {
  const { createPendingChat, withPendingChat, pendingChatSessionId } = await import("./chats.mjs");
  const state: CoordinatorState = {
    next_id: 4,
    projects: {},
    worktrees: {},
    sessions: { 1: session },
    messages: [{ id: 3, session_id: 1, body: "Original title", role: "user", context: null }],
    tasks: {},
  };
  const pending = createPendingChat({ state, worktreeId: 1, sessionId: 1, body: "Follow up", model: "m", provider: "codex" });
  assert.equal(pendingChatSessionId(state, pending), null, "previous messages are not acknowledgement of this send");
  const shown = withPendingChat(state, pending);
  assert.equal(shown.messages.length, 2);
  assert.equal(chatTitle(shown.sessions[1], shown.messages), "Original title");
  assert.equal(state.messages.length, 1);
  const concurrent = { ...state, messages: [...state.messages, { id: 4, session_id: 1, body: "Follow up", role: "user" as const, context: null }] };
  assert.equal(pendingChatSessionId(concurrent, pending), null, "another client sending the same text is not acknowledgement");
  const saved = { ...concurrent, messages: [...concurrent.messages, { ...pending.message, id: 5 }] };
  assert.equal(pendingChatSessionId(saved, pending), 1);
  assert.equal(withPendingChat(saved, pending), saved);
});

test("legacy acknowledgement requires an accepted target and a new untagged matching input", async () => {
  const { createPendingChat, pendingChatSessionId } = await import("./chats.mjs");
  const state: CoordinatorState = { next_id: 4, projects: {}, worktrees: {}, sessions: { 1: session }, messages: [], tasks: {} };
  const pending = createPendingChat({ state, worktreeId: 1, sessionId: 1, body: "Follow up", model: "m", provider: "codex" });
  const saved = { id: 4, session_id: 1, body: "Follow up", role: "user" as const, context: null };
  const acknowledged = { ...pending, acceptedSessionId: 1 };
  const resolve = (message: typeof saved & { clientMessageId?: string }) => pendingChatSessionId({ ...state, messages: [message] }, acknowledged);
  assert.equal(pendingChatSessionId({ ...state, messages: [saved] }, pending), null);
  assert.equal(resolve(saved), 1);
  assert.equal(resolve({ ...saved, id: 3 }), null);
  assert.equal(resolve({ ...saved, session_id: 2 }), null);
  assert.equal(resolve({ ...saved, body: "Other input" }), null);
  assert.equal(resolve({ ...saved, clientMessageId: "another-client" }), null);
});

test("comparePins puts pinned chats first in their order and leaves the rest alone", () => {
  const chats = [{ id: 1 }, { id: 2, pinned: true, pin_order: 5 }, { id: 3 }, { id: 4, pinned: true, pin_order: -1 }, { id: 5, pin_order: -9 }];
  assert.deepEqual(
    [...chats].sort(comparePins).map((chat) => chat.id),
    [4, 2, 1, 3, 5],
  );
});

test("pinOrderAt fits a chat between, before or after the pinned ones", () => {
  assert.equal(pinOrderAt([], 0), 0);
  assert.equal(pinOrderAt([2, 4], 0), 1);
  assert.equal(pinOrderAt([2, 4], 1), 3);
  assert.equal(pinOrderAt([2, 4], 2), 5);
  assert.equal(pinOrderAt([2, 3], 1), 2.5);
});

test("a resend of the same text reuses the failed send's client id, and anything else is a new message", async () => {
  const { createPendingChat, createResendMemory } = await import("./chats.mjs");
  const state: CoordinatorState = { next_id: 4, projects: {}, worktrees: {}, sessions: {}, messages: [], tasks: {} };
  const memory = createResendMemory();
  const first = createPendingChat({ state, worktreeId: 1, body: "Hello", model: "m", provider: "codex" });
  assert.equal(memory.reuse("chat", "Hello"), undefined);
  memory.remember("chat", first.message.clientMessageId!, "Hello", ["a"]);
  assert.equal(memory.reuse("other", "Hello", ["a"]), undefined);
  const again = createPendingChat({
    state,
    worktreeId: 1,
    body: "Hello",
    model: "m",
    provider: "codex",
    clientMessageId: memory.reuse("chat", "Hello", ["a"]),
  });
  assert.equal(again.message.clientMessageId, first.message.clientMessageId);
  assert.notEqual(again.message.id, first.message.id);
  assert.equal(memory.reuse("chat", "Hello", ["b"]), undefined, "other attachments are another message");
  assert.equal(memory.reuse("chat", "Hello", ["a"]), undefined, "an edited send forgets the old id");
  memory.remember("chat", "x", "Hi");
  memory.forget("chat");
  assert.equal(memory.reuse("chat", "Hi"), undefined);
});
