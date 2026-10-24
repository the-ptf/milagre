import assert from "node:assert/strict";
import test from "node:test";
import type { CoordinatorState } from "@milagre/shared/model";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { heartbeatKeys, heartbeatLines, mergeScopeChats, railLive, rememberScopeRows, runKeys, scopeChats, withHeartbeats } from "./sidebar-scopes.ts";
import { clock } from "@milagre/shared/routines";
import type { SidebarRecent } from "../components/sidebar/ChatRow";

const session = (id: number, extra = {}) => ({ id, worktree_id: 1, agent_name: "Claude", status: "Idle", ...extra });
const message = (id: number, session_id: number, body: string) => ({ id, session_id, role: "user", body });
const state = {
  worktrees: { 1: { id: 1, name: "main", path: "/code/shop" } },
  sessions: { 1: session(1), 2: session(2, { unread: true }), 3: session(3, { archived: true }), 4: session(4, { pinned: true, pin_order: 1 }) },
  messages: [message(1, 1, "Fix checkout"), message(2, 2, "Add search"), message(3, 3, "Old"), message(4, 4, "Pinned one")],
} as unknown as CoordinatorState;

test("another Project's chats: pinned first, newest next, archived left out, marks from its runs", () => {
  const rows = scopeChats("/code/shop", state, "created", { running: new Set(["/code/shop#1"]), waiting: new Set(), asking: new Set() });
  assert.deepEqual(
    rows.map((row) => [row.id, row.mark, row.details?.branch]),
    [
      ["4", "idle", "main"],
      ["2", "unread", "main"],
      ["1", "running", "main"],
    ],
  );
});

const hiddenRunState = {
  worktrees: { 1: { id: 1, name: "main", path: "/code/shop" } },
  sessions: {
    1: session(1),
    2: session(2, { routine: { routineId: "r1", runId: "u1", hidden: true } }),
    3: session(3, { routine: { routineId: "r1", runId: "u2", hidden: false } }),
  },
  messages: [message(1, 1, "Fix checkout"), message(2, 2, "Run result"), message(3, 3, "Kept run")],
} as unknown as CoordinatorState;

test("another Project's hidden Run Chats stay out of its rows, until one waits on an approval or a question", () => {
  const ids = (running: Set<string>, waiting: Set<string>, asking: Set<string>) =>
    scopeChats("/code/shop", hiddenRunState, "created", { running, waiting, asking }).map((row) => row.id);
  assert.deepEqual(ids(new Set(["/code/shop#2"]), new Set(), new Set()), ["3", "1"]);
  assert.deepEqual(ids(new Set(), new Set(["/code/shop#2"]), new Set()), ["3", "2", "1"]);
  assert.deepEqual(ids(new Set(), new Set(), new Set(["/code/shop#2"])), ["3", "2", "1"]);
  // Waiting on another Chat doesn't list this one.
  assert.deepEqual(ids(new Set(), new Set(["/code/shop#1"]), new Set(["/code/shop#3"])), ["3", "1"]);
});

const run = (approvals: number, questions: number) => ({
  approvals: Array.from({ length: approvals }, () => ({})),
  questions: Array.from({ length: questions }, () => ({})),
});

test("run keys cover Link chats: an approval waits, a question alone asks", () => {
  const keys = runKeys({ "milagre-link:x#1": run(1, 0), "milagre-link:x#2": run(0, 1), "/code/shop#3": run(0, 0) } as unknown as AgentRuns);
  assert.deepEqual(keys, {
    running: "milagre-link:x#1\nmilagre-link:x#2\n/code/shop#3",
    waiting: "milagre-link:x#1\nmilagre-link:x#2",
    asking: "milagre-link:x#2",
  });
});

const marks = { running: new Set<string>(), waiting: new Set<string>(), asking: new Set<string>() };
const pr = { number: 409, url: "https://github.com/x/y/pull/409", title: "Fix", state: "OPEN" };

test("a Project left behind keeps the PRs, issue and ports its rows showed while it was open", () => {
  rememberScopeRows("/code/shop", [
    {
      id: "1",
      label: "Fix checkout",
      details: { path: "/code/shop", pullRequests: [pr as never], linearKey: "ENG-1", linkable: true, ports: [{ port: 3000 } as never] },
    },
    { id: "2", label: "Add search", details: { path: "/code/shop", pullRequests: [pr as never] } },
    { id: "9", label: "Draft", pending: true, details: { path: "/code/shop", pullRequests: [pr as never] } },
  ]);
  const rows = scopeChats("/code/shop", state, "created", marks);
  const one = rows.find((row) => row.id === "1")!;
  assert.deepEqual(one.details?.pullRequests, [pr]);
  assert.equal(one.details?.linearKey, "ENG-1");
  assert.equal(one.details?.linkable, true);
  assert.deepEqual(one.details?.ports, [{ port: 3000 }]);
  assert.equal(one.details?.branch, "main", "the live state still names the branch");
  assert.equal(one.details?.failed, false);
  assert.deepEqual(rows.find((row) => row.id === "2")!.details?.pullRequests, [pr]);
  assert.equal(rows.find((row) => row.id === "4")!.details?.pullRequests, undefined, "a chat never shown open has nothing to keep");
});

test("a remembered row of a chat whose Worktree changed is dropped", () => {
  rememberScopeRows("/code/shop", [{ id: "1", label: "Fix checkout", details: { path: "/code/shop-old", pullRequests: [pr as never] } }]);
  const rows = scopeChats("/code/shop", state, "created", marks);
  assert.equal(rows.find((row) => row.id === "1")!.details?.pullRequests, undefined);
});

test("another scope's memory doesn't leak", () => {
  rememberScopeRows("/code/api", [{ id: "2", label: "Add search", details: { path: "/code/shop", pullRequests: [pr as never] } }]);
  rememberScopeRows("/code/shop", []);
  const rows = scopeChats("/code/shop", state, "created", marks);
  assert.equal(rows.find((row) => row.id === "2")!.details?.pullRequests, undefined);
});

test("rail status: asking or waiting beats running, and only live chats are listed", () => {
  const rows = [
    { id: "1", label: "a", mark: "running" as const },
    { id: "2", label: "b", mark: "unread" as const },
    { id: "3", label: "c", mark: "idle" as const },
    { id: "4", label: "d" },
  ];
  assert.deepEqual(railLive(rows), { status: "running", chats: [rows[0]] });
  assert.equal(railLive([...rows, { id: "5", label: "e", mark: "question" as const }]).status, "attention");
  assert.equal(railLive([...rows, { id: "5", label: "e", mark: "waiting" as const }]).status, "attention");
  assert.equal(railLive([{ id: "5", label: "e", mark: "delegated" as const }]).status, "running");
  assert.deepEqual(railLive(rows.slice(1)), { status: "idle", chats: [] });
});

test("heartbeatKeys holds the Chats of enabled heartbeats only, each with its hover line", () => {
  const at = Date.UTC(2026, 9, 17, 10, 45);
  const beat = (id: string, chatId: string, enabled: boolean) => ({
    id,
    name: id,
    prompt: "p",
    trigger: { kind: "schedule" as const, cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "chat" as const, chatId },
    enabled,
    createdBy: { kind: "user" as const },
    runCount: 0,
    nextRunAt: at,
    createdAt: 0,
    updatedAt: 0,
  });
  const trigger = { ...beat("t", "", true), target: { kind: "new-chat" as const, projectPath: "/code/shop", workspace: "worktree" as const } };
  const keys = heartbeatKeys([beat("on", "/code/shop#1", true), beat("off", "/code/shop#2", false), trigger]);
  assert.equal(keys, `/code/shop#1\tHeartbeat · every 15 min · next ${clock(at)}`);
  const lines = heartbeatLines(keys);
  assert.deepEqual([...lines.keys()], ["/code/shop#1"]);
  const rows = [
    { id: "1", label: "a" },
    { id: "2", label: "b" },
  ];
  const marked = withHeartbeats("/code/shop", rows, lines);
  assert.equal(marked[0]!.heartbeat, `Heartbeat · every 15 min · next ${clock(at)}`);
  // Rows without a heartbeat keep their object, so memoized rows don't re-render.
  assert.equal(marked[1], rows[1]);
  assert.equal(withHeartbeats("/code/shop", rows, new Map()), rows);
});

test("no pulse with the Routines switch off (no Routines read) or on an archived Chat", () => {
  const marks = { running: new Set<string>(), waiting: new Set<string>(), asking: new Set<string>() };
  const rows = scopeChats("/code/shop", state as unknown as CoordinatorState, "created", marks);
  // Switched off: the list is empty, so nothing is marked and the rows stay as they were.
  assert.equal(withHeartbeats("/code/shop", rows, heartbeatLines(heartbeatKeys([]))), rows);
  // A heartbeat on archived Chat 3: that Chat isn't listed, so no row carries it.
  const archived = heartbeatLines("/code/shop#3\tHeartbeat · every 15 min");
  assert.equal(
    withHeartbeats("/code/shop", rows, archived).some((row) => row.heartbeat),
    false,
  );
});

const flatRow = (id: string, lastAt: number | undefined, extra: Partial<SidebarRecent> = {}, firstAt?: number): SidebarRecent => ({
  id,
  label: id,
  details: { lastAt, firstAt },
  ...extra,
});

test("one list: pinned first across scopes by pin order, then the latest activity, each scope keeping its own order", () => {
  const merged = mergeScopeChats(
    [
      { key: "/a", rows: [flatRow("a-pin", 5, { pinned: true, pinOrder: 2 }), flatRow("a1", 90), flatRow("a2", 20)] },
      { key: "/b", rows: [flatRow("b-pin", 1, { pinned: true, pinOrder: 1 }), flatRow("b1", 50), flatRow("b2", 70)] },
    ],
    "recent",
  );
  assert.deepEqual(
    merged.map(({ scopeKey, row }) => `${scopeKey}${row.id}`),
    // b2 (70) waits behind b1 (50): a scope's rows stay in the order its setting gave them.
    ["/bb-pin", "/aa-pin", "/aa1", "/bb1", "/bb2", "/aa2"],
  );
});

test("one list: equal activity goes to the earlier scope, rows without activity keep their place, and an empty scope adds nothing", () => {
  const merged = mergeScopeChats(
    [
      { key: "/a", rows: [flatRow("a1", 10), flatRow("a2", undefined)] },
      { key: "/empty", rows: [] },
      { key: "/b", rows: [flatRow("b1", 10), flatRow("b2", undefined)] },
    ],
    "recent",
  );
  assert.deepEqual(
    merged.map(({ row }) => row.id),
    ["a1", "b1", "a2", "b2"],
  );
  assert.deepEqual(mergeScopeChats([], "recent"), []);
});

test("one list: newest Chat first orders across Projects by when each Chat began, whatever its id", () => {
  // /a's Chat 90 began before /b's Chat 2, though its id is larger and it was active more recently.
  const merged = mergeScopeChats(
    [
      { key: "/a", rows: [flatRow("90", 900, {}, 100), flatRow("80", 800, {}, 50)] },
      { key: "/b", rows: [flatRow("3", 300, {}, 400), flatRow("2", 200, {}, 300)] },
    ],
    "created",
  );
  assert.deepEqual(
    merged.map(({ scopeKey, row }) => `${scopeKey}${row.id}`),
    ["/b3", "/b2", "/a90", "/a80"],
  );
});

test("one list: latest message first orders across Projects by lastAt, whatever the ids", () => {
  const merged = mergeScopeChats(
    [
      { key: "/a", rows: [flatRow("90", 150, {}, 100)] },
      { key: "/b", rows: [flatRow("3", 400, {}, 5), flatRow("2", 160, {}, 4)] },
    ],
    "recent",
  );
  assert.deepEqual(
    merged.map(({ scopeKey, row }) => `${scopeKey}${row.id}`),
    ["/b3", "/b2", "/a90"],
  );
});

test("one list: a Chat without firstAt goes by its latest activity under newest first, and pins ignore the order", () => {
  const merged = mergeScopeChats(
    [
      { key: "/a", rows: [flatRow("a-pin", 1, { pinned: true, pinOrder: 2 }, 999), flatRow("old", 250, {}), flatRow("older", 10, {}, 5)] },
      { key: "/b", rows: [flatRow("b-pin", 1, { pinned: true, pinOrder: 1 }, 1), flatRow("b1", 900, {}, 300), flatRow("b2", 900, {}, 100)] },
    ],
    "created",
  );
  assert.deepEqual(
    merged.map(({ row }) => row.id),
    ["b-pin", "a-pin", "b1", "old", "b2", "older"],
  );
});

/** The merge as it was before the heap: every scope scanned for every row. The oracle for the heap one. */
function mergeByScan(scopes: readonly { key: string; rows: readonly SidebarRecent[] }[], order: "created" | "recent") {
  const merged: { scopeKey: string; row: SidebarRecent }[] = [];
  const timeOf = (row: SidebarRecent) => (order === "created" ? (row.details?.firstAt ?? row.details?.lastAt) : row.details?.lastAt) ?? 0;
  for (const pinned of [true, false]) {
    const queues = scopes.map(({ key, rows }) => ({ key, rows: rows.filter((row) => Boolean(row.pinned) === pinned), at: 0 }));
    const first = (a: SidebarRecent, b: SidebarRecent) => (pinned ? (a.pinOrder ?? 0) - (b.pinOrder ?? 0) : timeOf(b) - timeOf(a));
    for (;;) {
      let next: (typeof queues)[number] | undefined;
      let nextRow: SidebarRecent | undefined;
      for (const queue of queues) {
        const row = queue.rows[queue.at];
        if (row && (!nextRow || first(row, nextRow) < 0)) [next, nextRow] = [queue, row];
      }
      if (!next || !nextRow) break;
      next.at++;
      merged.push({ scopeKey: next.key, row: nextRow });
    }
  }
  return merged;
}

/** A repeatable stream of numbers in [0, 1). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

test("one list: the heap merge gives what a scan of every scope gave, on random scopes with ties, gaps and unsorted rows", () => {
  const random = seeded(7);
  const int = (below: number) => Math.floor(random() * below);
  for (let round = 0; round < 300; round++) {
    const scopes = Array.from({ length: int(12) }, (_, scope) => ({
      key: `/p${scope}`,
      rows: Array.from({ length: int(15) }, (_, at) =>
        // Few distinct times and pin orders, so ties are common; some rows have no times or no pin order.
        flatRow(
          `p${scope}-${at}`,
          random() < 0.15 ? undefined : int(8),
          random() < 0.3 ? { pinned: true, ...(random() < 0.8 ? { pinOrder: int(5) } : {}) } : {},
          random() < 0.25 ? undefined : int(8),
        ),
      ),
    }));
    for (const order of ["recent", "created"] as const) {
      const heap = mergeScopeChats(scopes, order);
      const scan = mergeByScan(scopes, order);
      assert.equal(heap.length, scan.length);
      heap.forEach((entry, at) => {
        assert.equal(entry.scopeKey, scan[at].scopeKey, `round ${round} ${order} #${at}`);
        assert.equal(entry.row, scan[at].row, `round ${round} ${order} #${at}`);
      });
    }
  }
});

test("one list: 200 Projects of 50 Chats merge quickly, in the order a scan gave", () => {
  const random = seeded(11);
  const scopes = Array.from({ length: 200 }, (_, scope) => ({
    key: `/p${scope}`,
    // Each scope's rows are newest first, as the setting leaves them; a few are pinned.
    rows: Array.from({ length: 50 }, (_, at) =>
      flatRow(`p${scope}-${at}`, 100000 - at * 100 - Math.floor(random() * 90), at < 2 ? { pinned: true, pinOrder: scope * 2 + at } : {}),
    ),
  }));
  const started = performance.now();
  const merged = mergeScopeChats(scopes, "recent");
  const took = performance.now() - started;
  assert.equal(merged.length, 10000);
  assert.ok(took < 250, `merged 10000 rows in ${took.toFixed(1)} ms`);
  const scan = mergeByScan(scopes, "recent");
  assert.ok(merged.every((entry, at) => entry.row === scan[at].row));
});
