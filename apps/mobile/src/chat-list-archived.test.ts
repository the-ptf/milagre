import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostView } from "./all-computers-store.ts";
import { listArchivedChats } from "./chat-list-archived.ts";

const chat = (id: number, extra: Record<string, unknown> = {}) => ({ id, worktree_id: 1, archived: true, title: `Chat ${id}`, ...extra });
const view = (hostId: string, name: string, sessions: Record<string, unknown>, link = false): HostView =>
  ({
    hostId,
    name,
    state: "online",
    lastSuccess: 0,
    loaded: true,
    projects: [{ path: "/p", name: "Project" }],
    errors: new Map(),
    copies: new Map([
      ["/p", { project: { path: "/p", link: link ? { projects: [] } : undefined, state: { sessions, messages: [], worktrees: { 1: { name: "feature" } } } } }],
    ]),
  }) as unknown as HostView;

test("archived Chats of every computer come newest first, by when they began and then by last activity", () => {
  const found = listArchivedChats([
    view("a", "Mac", {
      1: chat(1, { summary: { count: 1, firstAt: 10, lastAt: 90 } }),
      2: chat(2, { summary: { count: 1, firstAt: 50, lastAt: 60 } }),
      3: chat(3, { archived: false, summary: { count: 1, firstAt: 99, lastAt: 99 } }),
    }),
    view("b", "Laptop", { 4: chat(4, { summary: { count: 1, firstAt: 50, lastAt: 70 } }), 5: chat(5) }),
  ]);
  assert.deepEqual(
    found.map((item) => `${item.hostName}#${item.chat.id}`),
    ["Laptop#4", "Mac#2", "Mac#1", "Laptop#5"],
  );
});

test("a row names its Project, its computer and its branch, and a shared Link Chat has no branch", () => {
  const [row] = listArchivedChats([view("a", "Mac", { 1: chat(1) })]);
  assert.equal(row?.projectName, "Project");
  assert.equal(row?.branch, "feature");
  assert.equal(row?.hostId, "a");
  const [shared] = listArchivedChats([view("a", "Mac", { 1: chat(1) }, true)]);
  assert.equal(shared?.branch, "");
});

/** A Project whose messages count how many times they are walked. */
function counted(sessions: Record<string, unknown>, messages: unknown[]) {
  const stats = { passes: 0, filters: 0 };
  const list = [...messages];
  Object.defineProperty(list, Symbol.iterator, {
    value: function* () {
      stats.passes++;
      for (let index = 0; index < messages.length; index++) yield messages[index];
    },
  });
  Object.defineProperty(list, "filter", {
    value: () => {
      stats.filters++;
      return [];
    },
  });
  const v = view("a", "Mac", sessions);
  const copy = v.copies.get("/p") as unknown as { project: { state: { messages: unknown[] } } };
  copy.project.state.messages = list;
  return { view: v, stats };
}

test("the messages of a Project are read once, however many Chats are archived, and the titles are the same", () => {
  const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [index + 1, chat(index + 1, { title: "" })]));
  const messages = Array.from({ length: 40 }, (_, index) => ({ session_id: index + 1, role: "user", body: `question ${index + 1}` }));
  const { view: heavy, stats } = counted(sessions, messages);
  const rows = listArchivedChats([heavy]);
  assert.equal(rows.length, 40);
  assert.equal(stats.passes, 1, "one pass over the messages");
  assert.equal(stats.filters, 0, "never one filter per archived Chat");
  const plain = view("a", "Mac", sessions);
  (plain.copies.get("/p") as unknown as { project: { state: { messages: unknown[] } } }).project.state.messages = messages;
  assert.deepEqual(
    rows.map((row) => row.title),
    listArchivedChats([plain]).map((row) => row.title),
    "the same titles as reading the messages Chat by Chat",
  );
});

test("a Project copy that did not change is not read again by an unrelated store update", () => {
  const { view: first, stats } = counted({ 1: chat(1), 2: chat(2) }, [{ session_id: 1, role: "user", body: "hi" }]);
  const once = listArchivedChats([first]);
  assert.equal(stats.passes, 1);
  // The store publishes a new views array (another computer changed) holding the same copy.
  const again = listArchivedChats([{ ...first }, view("b", "Laptop", { 9: chat(9) })]);
  assert.equal(stats.passes, 1, "the unchanged copy is not walked again");
  assert.equal(
    again.find((row) => row.hostId === "a" && row.chat.id === 1),
    once.find((row) => row.chat.id === 1),
    "same row object",
  );
  // A renamed computer builds that copy's rows again.
  listArchivedChats([{ ...first, name: "Renamed" }]);
  assert.equal(stats.passes, 2);
});

test("only archived Chats are indexed, and a Project with none reads no messages at all", () => {
  const { view: quiet, stats } = counted({ 1: chat(1, { archived: false }) }, [{ session_id: 1, role: "user", body: "hi" }]);
  assert.deepEqual(listArchivedChats([quiet]), []);
  assert.equal(stats.passes, 0);
});
