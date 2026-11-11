import assert from "node:assert/strict";
import test from "node:test";
import { linkOwners, nestUnder, worktreeGroups, worktreeHeading } from "./project-list.ts";

type Item = { key: string; parent?: string };
const key = (item: Item) => item.key;
const parent = (item: Item) => item.parent;

test("entries go under the entry they name, in the order they came; one whose parent isn't listed stays on top", () => {
  const items: Item[] = [{ key: "/a" }, { key: "/b", parent: "link:1" }, { key: "/c", parent: "link:2" }, { key: "link:1" }, { key: "/d", parent: "link:1" }];
  assert.deepEqual(
    nestUnder(items, key, parent).map((node) => [node.item.key, node.children.map(key)]),
    [
      ["/a", []],
      ["/c", []],
      ["link:1", ["/b", "/d"]],
    ],
  );
});

test("a Project in several Named Links is drawn under the first one", () => {
  const owners = linkOwners([
    { key: "link:1", memberPaths: ["/api", "/web"] },
    { key: "link:2", memberPaths: ["/web", "/infra", ""] },
  ]);
  assert.deepEqual(
    [...owners],
    [
      ["/api", "link:1"],
      ["/web", "link:1"],
      ["/infra", "link:2"],
    ],
  );
});

test("a Project's Chats group by Worktree: the main checkout first, then the newest; only a shared Worktree gets a heading", () => {
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
    groups.map((group) => [group.name, group.primary, group.rows.map((row) => row.id), worktreeHeading(group)]),
    [
      ["main", true, ["2"], false],
      ["feature/x", false, ["1", "4"], true],
      ["milagre/gone", false, ["3"], false],
    ],
  );
  assert.deepEqual(worktreeGroups({ projectPath: "/p", worktrees: [], rows: [], pathOf: () => undefined, branchOf: () => undefined }), []);
});
