import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "@milagre/shared/model";
import {
  mergeTail,
  peekChatPage,
  refreshChatPage,
  savedChange,
  setChatPageDisk,
  subscribeChatPage,
  trimChatPage,
  warmChatPages,
  type PageDisk,
} from "./chat-pages.ts";

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

/** A disk that holds pages in memory, for these tests. */
function memoryDisk(kept: Record<string, ReturnType<typeof page>> = {}) {
  const writes: string[] = [];
  const disk: PageDisk = {
    read: async (key) => kept[key] ?? null,
    write: async (key, value) => {
      writes.push(key);
      kept[key] = value;
    },
  };
  return { disk, kept, writes };
}

test("a Chat opened before paints from its copy on the phone while its computer answers", async () => {
  const { disk } = memoryDisk({ "test://copy|/p#1": page([1, 2]) });
  setChatPageDisk(disk);
  let answer!: (value: ReturnType<typeof page>) => void;
  const client = { url: "test://copy", chatMessages: () => new Promise<ReturnType<typeof page>>((resolve) => (answer = resolve)) };
  const reading = refreshChatPage("test://copy|/p#1", client, "/p", 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ids(peekChatPage("test://copy|/p#1")!), [1, 2], "the copy shows at once");
  assert.equal(peekChatPage("test://copy|/p#1")?.loading, true);
  answer(page([1, 2, 3]));
  await reading;
  assert.deepEqual(ids(peekChatPage("test://copy|/p#1")!), [1, 2, 3], "the computer's answer replaces it");
  setChatPageDisk(null);
});

test("a computer's five most recent Chats are copied to the phone, skipping current copies and shown Chats", async () => {
  const { disk, writes } = memoryDisk({ "test://warm|/p#2": page([20]) });
  setChatPageDisk(disk);
  const reads: number[] = [];
  const client = {
    url: "test://warm",
    chatMessages: async (_path: string, chatId: number) => {
      reads.push(chatId);
      return page([chatId * 10]);
    },
  };
  // Chat 1 is on screen.
  await refreshChatPage("test://warm|/p#1", client, "/p", 1);
  reads.length = 0;
  const chats = [1, 2, 3, 4, 5, 6, 7].map((chatId) => ({ projectPath: "/p", chatId, lastAt: 100 - chatId, lastId: chatId * 10 }));
  let limited = 0;
  await warmChatPages(client, chats, (work) => (limited++, work()));
  // The five most recent: 1 (shown), 2 (its copy ends on its last message), then 3, 4, 5.
  assert.deepEqual(reads, [3, 4, 5]);
  assert.equal(limited, 3, "every read goes through the computer's request limit");
  assert.deepEqual(writes, ["test://warm|/p#3", "test://warm|/p#4", "test://warm|/p#5"]);
  await warmChatPages(client, chats);
  assert.deepEqual(reads, [3, 4, 5], "each Chat is copied once");
  setChatPageDisk(null);
});

test("a followed Chat's window stays bounded through successive refreshes, trimming after the read in flight", async () => {
  const key = "test://trim|/p#1";
  const server = Array.from({ length: 30 }, (_, index) => index + 1);
  let hold: Promise<void> | null = null;
  const client = {
    url: "test://trim",
    chatMessages: async (_path: string, _chatId: number, options?: { turns?: number }) => {
      if (hold) await hold;
      const turns = options?.turns ?? 20;
      return page(server.slice(-turns), server.length > turns, server.length);
    },
  };
  let notified = 0;
  const stop = subscribeChatPage(key, () => notified++);
  await refreshChatPage(key, client, "/p", 1);
  assert.equal(peekChatPage(key)?.messages.length, 20);
  // Each saved message reads the last turns again and grows the window a reader holds.
  for (let id = 31; id <= 55; id++) {
    server.push(id);
    await refreshChatPage(key, client, "/p", 1);
  }
  assert.equal(peekChatPage(key)?.messages.length, 45, "a read window keeps what it showed");
  // The screen asks to trim while the refresh bringing the next message is still on its way.
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  server.push(56);
  const refresh = refreshChatPage(key, client, "/p", 1);
  trimChatPage(key, () => true);
  assert.equal(peekChatPage(key)?.messages.length, 45, "nothing is trimmed under a read in flight");
  const before = notified;
  release();
  hold = null;
  await refresh;
  const trimmed = peekChatPage(key)!;
  assert.deepEqual(
    ids(trimmed),
    Array.from({ length: 20 }, (_, index) => 37 + index),
    "the read settled, then the window kept its last turns",
  );
  assert.equal(trimmed.hasMore, true, "the dropped turns read again on scroll");
  assert.equal(trimmed.total, 56);
  assert.ok(notified > before, "the reader hears of the trim");
  // A reader who scrolled up while the read was on its way keeps everything.
  for (let id = 57; id <= 80; id++) {
    server.push(id);
    await refreshChatPage(key, client, "/p", 1);
  }
  hold = new Promise((resolve) => (release = resolve));
  server.push(81);
  const second = refreshChatPage(key, client, "/p", 1);
  trimChatPage(key, () => false);
  release();
  hold = null;
  await second;
  assert.equal(peekChatPage(key)?.messages.length, 45, "a reader scrolled up keeps the history");
  stop();
});
