import assert from "node:assert/strict";
import test from "node:test";
import type { Subagent } from "./model.ts";
import { buildSubagentTree, flattenSubagentTree, subagentAncestors, subagentStatusLabel } from "./subagent-tree.mjs";

const agent = (id: string, fields: Partial<Subagent> = {}): Subagent => ({
  id,
  title: id,
  status: "running",
  startedAt: 1,
  updatedAt: 1,
  transcript: [],
  ...fields,
});

test("empty and flat trees preserve input order and have separate status counts", () => {
  assert.deepEqual(buildSubagentTree([]).counts, { total: 0, running: 0, waiting: 0, failed: 0, done: 0 });
  const tree = buildSubagentTree([
    agent("starting", { status: "initializing" }),
    agent("running"),
    agent("paused", { status: "waiting" }),
    agent("failed", { status: "failed" }),
    agent("done", { status: "completed" }),
    agent("stopped", { status: "cancelled" }),
    agent("unknown", { status: "unknown" }),
  ]);
  assert.deepEqual(
    tree.roots.map((node) => node.agent.id),
    ["starting", "running", "paused", "failed", "done", "stopped", "unknown"],
  );
  assert.deepEqual(tree.counts, { total: 7, running: 2, waiting: 1, failed: 1, done: 2 });
  assert.equal(tree.nested, false);
});

test("children can arrive before parents and roll their status counts up each branch", () => {
  const parent = agent("parent");
  const child = agent("child", { parentId: "parent", status: "waiting" });
  const leaf = agent("leaf", { parentId: "child", status: "failed" });
  const sibling = agent("sibling", { parentId: "parent", status: "completed" });
  const input = Object.freeze([leaf, child, parent, sibling].map((item) => Object.freeze(item)));
  const tree = buildSubagentTree(input);
  assert.deepEqual(
    tree.roots.map((node) => node.agent.id),
    ["parent"],
  );
  assert.equal(tree.nodes.get("parent")?.agent, parent);
  assert.deepEqual(
    tree.nodes.get("parent")?.children.map((node) => node.agent.id),
    ["child", "sibling"],
  );
  assert.deepEqual(tree.nodes.get("child")?.counts, { total: 2, running: 0, waiting: 1, failed: 1, done: 0 });
  assert.deepEqual(tree.nodes.get("parent")?.counts, { total: 4, running: 1, waiting: 1, failed: 1, done: 1 });
  assert.deepEqual(tree.counts, tree.nodes.get("parent")?.counts);
  assert.equal(tree.nested, true);
});

test("unknown, archived and self parents attach to root; first visible duplicate wins", () => {
  const first = agent("duplicate", { title: "First visible" });
  const tree = buildSubagentTree([
    agent("archived", { archived: true }),
    agent("orphan", { parentId: "archived" }),
    agent("missing", { parentId: "absent" }),
    agent("self", { parentId: "self" }),
    agent("duplicate", { archived: true }),
    first,
    agent("duplicate", { title: "Later duplicate", parentId: "orphan" }),
  ]);
  assert.equal(tree.nodes.has("archived"), false);
  assert.deepEqual(
    tree.roots.map((node) => node.agent.id),
    ["orphan", "missing", "self", "duplicate"],
  );
  assert.equal(tree.nodes.get("duplicate")?.agent, first);
  assert.equal(tree.nodes.get("self")?.parentId, undefined);
  assert.equal(tree.counts.total, 4);
  assert.equal(tree.nested, false);
});

test("all cycle members become roots while their valid descendants remain attached", () => {
  const tree = buildSubagentTree([
    agent("leaf", { parentId: "a" }),
    agent("a", { parentId: "b" }),
    agent("b", { parentId: "c" }),
    agent("c", { parentId: "a" }),
    agent("other-leaf", { parentId: "b" }),
  ]);
  assert.deepEqual(
    tree.roots.map((node) => node.agent.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    tree.roots.map((node) => node.parentId),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    tree.nodes.get("a")?.children.map((node) => node.agent.id),
    ["leaf"],
  );
  assert.deepEqual(
    tree.nodes.get("b")?.children.map((node) => node.agent.id),
    ["other-leaf"],
  );
  assert.equal(tree.counts.total, 5);
  assert.deepEqual(subagentAncestors(tree, "leaf"), ["a"]);
});

test("flattening follows preorder and collapse hides descendants without changing branch counts", () => {
  const tree = buildSubagentTree([agent("a"), agent("a1", { parentId: "a" }), agent("a11", { parentId: "a1" }), agent("a2", { parentId: "a" }), agent("b")]);
  const rows = (collapsed: Set<string>) => flattenSubagentTree(tree, collapsed).map(({ node, depth }) => [node.agent.id, depth]);
  assert.deepEqual(rows(new Set()), [
    ["a", 0],
    ["a1", 1],
    ["a11", 2],
    ["a2", 1],
    ["b", 0],
  ]);
  assert.deepEqual(rows(new Set(["a1", "missing"])), [
    ["a", 0],
    ["a1", 1],
    ["a2", 1],
    ["b", 0],
  ]);
  assert.deepEqual(rows(new Set(["a"])), [
    ["a", 0],
    ["b", 0],
  ]);
  assert.equal(tree.nodes.get("a")?.counts.total, 4);
  assert.deepEqual(subagentAncestors(tree, "a11"), ["a", "a1"]);
  assert.deepEqual(subagentAncestors(tree, "a"), []);
  assert.deepEqual(subagentAncestors(tree, "missing"), []);
});

test("very deep chains build, count, flatten and reveal without recursive stack overflow", () => {
  const size = 20_000;
  const tree = buildSubagentTree(Array.from({ length: size }, (_, index) => agent(String(index), index ? { parentId: String(index - 1) } : {})));
  assert.equal(tree.roots[0].counts.total, size);
  const rows = flattenSubagentTree(tree, new Set());
  assert.equal(rows.length, size);
  assert.equal(rows.at(-1)?.depth, size - 1);
  const ancestors = subagentAncestors(tree, String(size - 1));
  assert.equal(ancestors.length, size - 1);
  assert.equal(ancestors[0], "0");
  assert.equal(ancestors.at(-1), String(size - 2));
});

test("shared status labels describe paused agents as Waiting", () => {
  assert.deepEqual((["initializing", "running", "waiting", "completed", "failed", "cancelled", "unknown"] as const).map(subagentStatusLabel), [
    "Starting",
    "Running",
    "Waiting",
    "Completed",
    "Failed",
    "Stopped",
    "Status unavailable",
  ]);
});
