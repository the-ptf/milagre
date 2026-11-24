import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession, ChatMessage } from "@milagre/shared/model";
import { doneReplyId } from "./chat-done.ts";

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
