import assert from "node:assert/strict";
import test from "node:test";
import { accountFallbackLabel, projectTree, worktreeGroups } from "./project-list.ts";

type Item = { key: string; parent?: string };
const key = (item: Item) => item.key;
const parent = (item: Item) => item.parent;

test("Sub-projects go under their parent, in the order they came, wherever the list put them", () => {
  const items: Item[] = [{ key: "/b/api", parent: "/b" }, { key: "/a" }, { key: "/b" }, { key: "/b/web", parent: "/b" }, { key: "/c/x", parent: "/c" }];
  assert.deepEqual(
    projectTree(items, key, parent).map((node) => [node.item.key, node.children.map(key)]),
    [
      ["/a", []],
      ["/b", ["/b/api", "/b/web"]],
      ["/c/x", []],
    ],
  );
});

test("a Sub-project's Chats group by Worktree: the main checkout first, then the newest", () => {
  const rows = [
    { id: "1", path: "/p/wt/feature", branch: "feature" },
    { id: "2", path: "/p" },
    { id: "3", path: "/p/wt/gone", branch: "milagre/gone" },
    { id: "4", path: "/p/wt/feature", branch: "feature" },
  ];
  const groups = worktreeGroups({
    projectPath: "/p",
    worktrees: [
      { path: "/p", name: "main" },
      { path: "/p/wt/feature", name: "feature/x" },
      { path: "/p/wt/idle", name: "idle" },
    ],
    rows,
    pathOf: (row) => row.path,
    branchOf: (row) => row.branch,
  });
  assert.deepEqual(
    groups.map((group) => [group.name, group.primary, group.rows.map((row) => row.id)]),
    [
      ["main", true, ["2"]],
      ["feature/x", false, ["1", "4"]],
      ["milagre/gone", false, ["3"]],
    ],
  );
});

test("a Sub-project without Chats has no Worktree rows; with one, its main checkout shows even when empty", () => {
  assert.deepEqual(worktreeGroups({ projectPath: "/p/api", worktrees: [], rows: [], pathOf: () => undefined, branchOf: () => undefined }), []);
  const groups = worktreeGroups({
    projectPath: "/p/api",
    worktrees: [{ path: "/p/api", name: "main" }],
    rows: [{ path: "/p/wt/x" }],
    pathOf: (row) => row.path,
    branchOf: () => "x",
  });
  assert.deepEqual(
    groups.map((group) => [group.name, group.primary, group.rows.length]),
    [
      ["main", true, 0],
      ["x", false, 1],
    ],
  );
});

test("a Sub-project's account picker offers its Parent Project's account", () => {
  assert.equal(accountFallbackLabel("/work/urbis"), "Use urbis's account");
  assert.equal(accountFallbackLabel(undefined), "Use computer default");
});
