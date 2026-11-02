import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../model.ts";

// A stand-in for the preload: the test plays the host, which keeps each Chat's messages and answers page reads.
type Listener = (update: any) => void;
const raw: Record<string, Listener[]> = { project: [], snapshot: [] };
const chats = new Map<string, ChatMessage[]>();
const gate: { held: Promise<void> | null } = { held: null };
(globalThis as any).window = {
  milagre: {
    onProjectState: (listener: Listener) => (raw.project.push(listener), () => {}),
    onRuntimeSnapshot: (listener: Listener) => (raw.snapshot.push(listener), () => {}),
    async readChatMessages(scope: string, chatId: number, { turns = 20, before }: { turns?: number; before?: number } = {}) {
      await gate.held;
      const all = chats.get(`${scope}#${chatId}`) ?? [];
      const end = before === undefined ? all.length : all.findIndex((message) => message.id === before);
      let start = end;
      for (let count = 0; start > 0 && count < turns;) if (all[--start]!.role === "user") count++;
      return { messages: all.slice(start, end), hasMore: start > 0, total: all.length };
    },
  },
};
const { loadEarlier, peekChatWindow, prefetchChatMessages, trimChatWindow, watchChatWindow } = await import("./chat-messages.ts");
const { seedHeldState } = await import("./state-events.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const turn = (chatId: number, n: number): ChatMessage[] => [
  { id: n * 2 - 1, session_id: chatId, role: "user", body: `ask ${n}`, context: null } as ChatMessage,
  { id: n * 2, session_id: chatId, role: "assistant", body: `answer ${n}`, context: null } as ChatMessage,
];
const turnsOf = (window: { messages: ChatMessage[] } | undefined) => window?.messages.filter((message) => message.role === "user").length ?? 0;
let version = 1;

/** A Chat on the host with `count` turns, read into its window by a reader that keeps it open. */
async function openChat(scope: string, chatId: number, count: number) {
  chats.set(`${scope}#${chatId}`, Array.from({ length: count }, (_, index) => turn(chatId, index + 1)).flat());
  seedHeldState(scope, { state: { sessions: { [chatId]: { id: chatId } }, messages: [], messagesInChats: true }, version, epoch: "host" });
  let heard = 0;
  watchChatWindow(scope, chatId, () => heard++);
  prefetchChatMessages(scope, chatId);
  await tick();
  return { heard: () => heard };
}

/** The host saves `count` more turns and tells the window, as a streaming Chat's patches do. */
function addTurns(scope: string, chatId: number, count: number) {
  const all = chats.get(`${scope}#${chatId}`)!;
  for (let index = 0; index < count; index++) {
    const added = turn(chatId, all.length / 2 + 1);
    for (const message of added) {
      const after = all.at(-1)?.id ?? null;
      all.push(message);
      for (const listener of raw.project)
        listener({ path: scope, base: version, version: ++version, epoch: "host", messages: { changed: [{ message, after }], removed: [] } });
    }
  }
}

test("a trim asked for while earlier messages are read waits for them, then trims and tells the readers", async () => {
  const scope = "/code/trim-earlier";
  const chat = await openChat(scope, 1, 30);
  addTurns(scope, 1, 25);
  assert.equal(turnsOf(peekChatWindow(scope, 1)), 45, "a read window keeps every turn that arrived");
  let release!: () => void;
  gate.held = new Promise((resolve) => (release = resolve));
  const earlier = loadEarlier(scope, 1);
  const heard = chat.heard();
  trimChatWindow(scope, 1, () => true);
  assert.equal(turnsOf(peekChatWindow(scope, 1)), 45, "nothing goes while the read is on its way");
  assert.equal(chat.heard(), heard);
  gate.held = null;
  release();
  await earlier;
  await tick();
  const window = peekChatWindow(scope, 1)!;
  assert.equal(turnsOf(window), 20);
  assert.equal(window.messages[0]!.role, "user");
  assert.equal(window.messages.at(-1)!.id, 110, "the window keeps the Chat's last turns");
  assert.equal(window.hasMore, true, "scrolling up reads the rest again");
  assert.equal(window.total, 110);
  assert.ok(chat.heard() > heard + 1, "readers hear the earlier page and then the trim");
});

test("a trim held for a read is skipped when the reader no longer wants it once the read ends", async () => {
  const scope = "/code/trim-scrolled";
  await openChat(scope, 2, 30);
  addTurns(scope, 2, 25);
  let release!: () => void;
  gate.held = new Promise((resolve) => (release = resolve));
  const earlier = loadEarlier(scope, 2);
  let following = true;
  trimChatWindow(scope, 2, () => following);
  // The reader scrolls up while the read is on its way.
  following = false;
  gate.held = null;
  release();
  await earlier;
  await tick();
  const window = peekChatWindow(scope, 2)!;
  assert.equal(turnsOf(window), 55, "the earlier page went in and nothing was trimmed");
  assert.equal(window.hasMore, false);
});

test("a Chat followed at its bottom through many turns and reads again keeps a bounded window", async () => {
  const scope = "/code/trim-follow";
  await openChat(scope, 3, 10);
  let most = 0;
  for (let round = 1; round <= 120; round++) {
    addTurns(scope, 3, 1);
    // The transcript asks for a trim as each new message arrives while it follows the bottom.
    trimChatWindow(scope, 3, () => true);
    most = Math.max(most, turnsOf(peekChatWindow(scope, 3)));
    // A reconnect now and then reads the window again, with the trim asked for while it is on its way.
    if (round % 35 === 0) {
      for (const listener of raw.snapshot) listener({ projects: [{ path: scope, state: { messages: [], messagesInChats: true } }] });
      trimChatWindow(scope, 3, () => true);
      await tick();
    }
  }
  const window = peekChatWindow(scope, 3)!;
  assert.ok(most <= 41, `the window never held more than twice its turns and one (held ${most})`);
  assert.ok(turnsOf(window) >= 20 && turnsOf(window) <= 40);
  assert.equal(window.hasMore, true);
  assert.equal(window.total, 260, "the total counts every message, held or not");
  const all = chats.get(`${scope}#3`)!;
  assert.deepEqual(
    window.messages.map((message) => message.id),
    all.slice(-window.messages.length).map((message) => message.id),
    "the window is the Chat's latest messages, in order",
  );
});
