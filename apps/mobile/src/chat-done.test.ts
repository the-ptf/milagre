import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, ChatMessage } from "@milagre/shared/model";
import { undoHistory } from "@milagre/shared/undo-history";
import { closeTabIntoDone, doneReplyId, settleActions } from "./chat-done.ts";

const chat = (patch: Partial<AgentSession> = {}) => ({ id: 1, ...patch }) as AgentSession;
const message = (id: number, role: ChatMessage["role"]) => ({ id, session_id: 1, role, body: "", context: null }) as ChatMessage;
const idle = { run: undefined, pending: undefined, offline: false };
const thread = [message(1, "user"), message(2, "assistant")];

test("only the last reply of an idle, open Chat carries Done", () => {
  assert.equal(doneReplyId(chat(), thread, idle), 2);
  assert.equal(doneReplyId(chat(), [...thread, message(3, "user")], idle), undefined, "a prompt waiting for its reply");
  assert.equal(doneReplyId(chat(), thread, { ...idle, run: {} }), undefined, "the agent is working");
  assert.equal(doneReplyId(chat(), thread, { ...idle, pending: {} }), undefined, "a message is being sent");
  assert.equal(doneReplyId(chat(), thread, { ...idle, offline: true }), undefined, "the computer is offline");
  assert.equal(doneReplyId(chat({ done_at: 5 }), thread, idle), undefined, "already Done");
  assert.equal(doneReplyId(null, thread, idle), undefined);
});

test("settling snoozes or marks Done, leaves the Chat, and Undo reverses it", async () => {
  const calls: unknown[][] = [];
  let left = 0;
  const settle = {
    client: { call: async <T>(method: string, args?: unknown[]) => (calls.push([method, ...(args ?? [])]), undefined as T) },
    projectPath: "/p",
    action: async (work: () => Promise<unknown>) => (await work(), true),
    leave: () => left++,
  };
  assert.equal(settleActions({ chat: chat(), messages: thread, busy: { ...idle, run: {} } }, settle), undefined, "nothing to settle while the agent works");
  const actions = settleActions({ chat: chat(), messages: thread, busy: idle }, settle);
  actions?.snooze(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["chat:patch", "/p", 1, { snoozed_until: 5000 }]);
  assert.equal(left, 1);
  undoHistory.undo();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["chat:patch", "/p", 1, { snoozed_until: false }]);
  actions?.done();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["chat:patch", "/p", 1, { done: true, unread: false }]);
  assert.equal(left, 2);
});

test("closing a tab Chat stops its turn and moves it to Done, and Undo brings it back with its tab", async () => {
  const calls: unknown[][] = [];
  const tabs: boolean[] = [];
  const client = { url: "host", call: async <T>(method: string, args?: unknown[]) => (calls.push([method, ...(args ?? [])]), undefined as T) };
  assert.equal(await closeTabIntoDone({ client, projectPath: "/p", chatId: 3, running: true, tab: (open) => tabs.push(open) }), true);
  assert.deepEqual(calls, [
    ["agent:interrupt", "/p#3"],
    ["chat:patch", "/p", 3, { done: true, unread: false }],
  ]);
  undoHistory.undo();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["chat:patch", "/p", 3, { done: false }]);
  assert.deepEqual(tabs, [false, true]);
});

test("a tab Chat the computer won't move to Done gets its tab back", async () => {
  const tabs: boolean[] = [];
  const client = { call: async () => Promise.reject(new Error("offline")) };
  assert.equal(await closeTabIntoDone({ client, projectPath: "/p", chatId: 3, running: false, tab: (open) => tabs.push(open) }), false);
  assert.deepEqual(tabs, [false, true]);
});
