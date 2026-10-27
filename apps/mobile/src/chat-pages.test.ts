import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@milagre/shared/model";
import { mergeTail, refreshChatPage, savedChange } from "./chat-pages.ts";

const message = (id: number, body = `m${id}`) => ({ id, session_id: 1, body, role: "user", context: null }) as ChatMessage;
const page = (ids: number[], hasMore = false, total = ids.length) => ({ messages: ids.map((id) => message(id)), hasMore, total });
const ids = (value: { messages: ChatMessage[] } | null) => value?.messages.map((item) => item.id);

test("the Chat's last turns read again replace the window's, keeping what came before", () => {
  const current = page([1, 2, 3, 4], true, 10);
  assert.deepEqual(ids(mergeTail(current, page([3, 4, 5], true, 11))), [1, 2, 3, 4, 5]);
  const edited = mergeTail(current, { messages: [message(3, "edited"), message(4)], hasMore: true, total: 10 });
  assert.ok(edited?.messages[2]);
  assert.equal(edited.messages[2].body, "edited");
  assert.deepEqual(ids(mergeTail(current, page([3], true, 9))), [1, 2, 3], "a removed message goes");
});

test("an unchanged tail keeps the same window, and one that starts after the window asks for a reload", () => {
  const current = page([1, 2, 3, 4], true, 10);
  assert.equal(mergeTail(current, page([3, 4], true, 10)), current);
  assert.equal(mergeTail(current, page([7, 8], true, 14)), null);
  assert.deepEqual(ids(mergeTail(page([]), page([1, 2]))), [1, 2], "an empty window takes the tail");
});

test("a read of the streaming turns alone never reads the Chat's messages again; a new Project state reads its last turns once", async () => {
  const reads: (number | undefined)[] = [];
  const client = {
    url: "test://pages",
    chatMessages: async (_path: string, _chatId: number, options?: { turns?: number }) => {
      reads.push(options?.turns);
      return page([1, 2]);
    },
  };
  const first = { project: { path: "/p", state: { sessions: {} } }, runs: { runs: {}, seq: 1 } };
  // A runs read: the same Project state, new runs (session.tsx keeps them out of the snapshot, but a whole one has both).
  const runsOnly = { ...first, runs: { runs: { "/p#1": {} }, seq: 2 } };
  const saved = { project: { path: "/p", state: { sessions: {}, saved: true } }, runs: runsOnly.runs };
  // What useChatPage's effect does: read when what it depends on (savedChange of `changed`) is a new value.
  let last: unknown = Symbol("none");
  const render = async (changed: unknown) => {
    const key = savedChange(changed);
    if (key === last) return;
    last = key;
    await refreshChatPage("test://pages|/p#1", client, "/p", 1);
  };
  await render(first);
  assert.deepEqual(reads, [20], "the first showing reads the window");
  await render(runsOnly);
  await render({ ...runsOnly, runs: { runs: {}, seq: 3 } });
  assert.deepEqual(reads, [20], "runs-only changes read nothing");
  await render(saved);
  assert.deepEqual(reads, [20, 2], "a new Project state reads the last turns once");
  assert.equal(savedChange(saved.project.state), saved.project.state, "a Project state passed as is counts as itself");
});
