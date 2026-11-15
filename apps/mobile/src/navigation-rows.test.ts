import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@milagre/shared/model";
import type { ProjectCopy } from "./all-computers-store";
import type { ChatEntry, HostBuild, ProjectBuild, Row } from "./navigation-build.ts";
import { computeRows, searchRows, type RowsInput } from "./navigation-rows.ts";

const entry = (id: number, title: string, chat: Partial<AgentSession> = {}): ChatEntry => ({
  chat: { id, worktree_id: 1, ...chat } as AgentSession,
  title,
  sortId: id,
  mark: "idle",
  background: 0,
  worktree: "main",
  prRefs: [],
});

const project = (path: string, chats: ChatEntry[], extra: Partial<ProjectBuild> = {}): ProjectBuild => ({
  path,
  name: path.split("/").at(-1)!,
  link: false,
  copy: { project: { state: { messages: [] } } } as unknown as ProjectCopy,
  all: chats,
  chats,
  done: [],
  snoozed: [],
  ...extra,
});

const host = (projects: ProjectBuild[], extra: Partial<HostBuild> = {}): HostBuild => ({
  hostId: "mac",
  hostName: "MacBook",
  reach: "local" as HostBuild["reach"],
  projects,
  loaded: true,
  ...extra,
});

const input = (builds: HostBuild[], extra: Partial<RowsInput> = {}): RowsInput => ({
  builds,
  chatList: "grouped",
  needle: "",
  show: "all",
  manyHosts: builds.length > 1,
  folds: new Map(),
  chatsFolded: false,
  doneOpen: false,
  snoozedOpen: false,
  subchatFolds: { has: () => true },
  ...extra,
});

const keys = (rows: Row[]) => rows.map((row) => row.key);

test("grouped: each Project's header, then its Chats; a folded Project shows only its header", () => {
  const builds = [host([project("/a", [entry(2, "Second"), entry(1, "First")]), project("/b", [entry(3, "Third")])])];
  assert.deepEqual(keys(computeRows(input(builds)).rows), ["mac|/a", "mac|/a#2", "mac|/a#1", "mac|/b", "mac|/b#3"]);
  const folded = computeRows(input(builds, { folds: new Map([["mac", new Set(["/a"])]]) })).rows;
  assert.deepEqual(keys(folded), ["mac|/a", "mac|/b", "mac|/b#3"]);
  assert.equal(folded[0]!.kind === "project" && folded[0]!.count, 2);
});

test("a Project with no Chats yet says so, and a computer still loading has its notice", () => {
  const rows = computeRows(input([host([project("/empty", [])]), host([], { hostId: "studio", hostName: "Studio", loaded: false })])).rows;
  const notices = rows.filter((row) => row.kind === "notice").map((row) => row.kind === "notice" && row.message);
  assert.deepEqual(notices, ["No Chats yet. Start one with +.", "Loading chats from Studio..."]);
});

test("a search lists matching Chats under one heading and the Projects whose name matches", () => {
  const builds = [host([project("/alpha", [entry(1, "Fix login")]), project("/beta", [])])];
  const { rows, projectHits, searchable } = computeRows(input(builds, { needle: "alpha" }));
  assert.deepEqual(keys(rows), ["section:Chats", "mac|/alpha#1"]);
  assert.deepEqual(keys(projectHits), ["mac|/alpha:hit"]);
  assert.deepEqual(
    searchable.map((scope) => scope.path),
    ["/alpha", "/beta"],
  );
});

test("Snoozed and Done sit under the list, folded to a header with their count until opened", () => {
  const done = [entry(5, "Shipped", { done_at: 10 }), entry(6, "Merged", { done_at: 20 })];
  const builds = [host([project("/a", [entry(1, "Open")], { done, snoozed: [entry(7, "Later", { snoozed_until: 99 })] })])];
  const folded = computeRows(input(builds)).rows;
  assert.deepEqual(keys(folded).slice(-2), ["snoozed-header", "done-header"]);
  const open = computeRows(input(builds, { doneOpen: true, snoozedOpen: true })).rows;
  assert.deepEqual(keys(open).slice(-5), ["snoozed-header", "snoozed:mac|/a#7", "done-header", "done:mac|/a#6", "done:mac|/a#5"]);
});

test("a Show filter that leaves nothing says so", () => {
  const builds = [host([project("/a", [], { all: [entry(1, "Idle")] })])];
  const rows = computeRows(input(builds, { show: "needs" })).rows;
  assert.deepEqual(rows[0], { key: "filter-empty", path: "", kind: "section", name: "No Chats match this filter." });
});

test("a search that finds nothing offers to start a Chat with it, then the Settings it matches", () => {
  const rows = searchRows({
    rows: [],
    needle: "appearance",
    query: "Appearance",
    searchable: [],
    hostMatches: { query: "", matches: {} },
    projectHits: [],
    manyHosts: false,
    connected: true,
    ipad: false,
  });
  assert.deepEqual(rows[0], { key: "start", path: "", kind: "start", query: "Appearance" });
  assert.equal(rows[1]?.key, "section:Settings");
  assert.ok(rows.slice(2).every((row) => row.kind === "settingHit"));
});
