import assert from "node:assert/strict";
import test from "node:test";
import type { Subagent } from "./model.ts";
import { subagentCounts, subagentTree } from "./subagent-tree.ts";

const agent = (id: string, parentId?: string, status: Subagent["status"] = "completed"): Subagent => ({
  id,
  title: id,
  status,
  startedAt: 0,
  transcript: [],
  ...(parentId ? { parentId } : {}),
});
const shape = (rows: ReturnType<typeof subagentTree>["rows"]) =>
  rows.map((row) => [row.agent.id, row.depth, row.parent ?? null, row.children, row.last, row.rails.join(",")]);

test("a flat list stays in start order and isn't nested", () => {
  const { rows, nested } = subagentTree([agent("a"), agent("b"), agent("c")]);
  assert.equal(nested, false);
  assert.deepEqual(
    rows.map((row) => [row.agent.id, row.depth]),
    [
      ["a", 0],
      ["b", 0],
      ["c", 0],
    ],
  );
});

test("children follow their parent in start order, with where each level's guide line ends", () => {
  const { rows, nested } = subagentTree([
    agent("map"),
    agent("build"),
    agent("find", "map"),
    agent("tests", "build"),
    agent("fix", "build"),
    agent("date", "tests"),
    agent("zone", "tests"),
    agent("review"),
  ]);
  assert.equal(nested, true);
  assert.deepEqual(shape(rows), [
    ["map", 0, null, 1, true, ""],
    ["find", 1, "map", 0, true, ""],
    ["build", 0, null, 2, true, ""],
    ["tests", 1, "build", 2, false, ""],
    ["date", 2, "tests", 0, false, "true"],
    ["zone", 2, "tests", 0, true, "true"],
    ["fix", 1, "build", 0, true, ""],
    ["review", 0, null, 0, true, ""],
  ]);
});

test("a subagent whose parent isn't listed, or is itself, sits at the top", () => {
  const { rows, nested } = subagentTree([agent("orphan", "archived-parent"), agent("self", "self")]);
  assert.equal(nested, false);
  assert.deepEqual(shape(rows), [
    ["orphan", 0, null, 0, true, ""],
    ["self", 0, null, 0, true, ""],
  ]);
});

test("a cycle breaks at its first listed member and a repeated id shows once", () => {
  const { rows } = subagentTree([agent("a", "b"), agent("b", "a"), agent("a", "b"), agent("c", "b")]);
  assert.deepEqual(shape(rows), [
    ["a", 0, null, 1, true, ""],
    ["b", 1, "a", 1, true, ""],
    ["c", 2, "b", 0, true, "false"],
  ]);
});

test("a folded branch hides everything under it and says whether something in it failed or runs", () => {
  const agents = [agent("root"), agent("child", "root"), agent("grandchild", "child", "running"), agent("other")];
  const running = subagentTree(agents, new Set(["root"]));
  assert.equal(running.nested, true);
  assert.deepEqual(
    running.rows.map((row) => [row.agent.id, row.folded, row.children, row.hidden ?? null]),
    [
      ["root", true, 1, "running"],
      ["other", false, 0, null],
    ],
  );
  const failed = subagentTree([...agents, agent("broken", "child", "failed")], new Set(["root"]));
  assert.equal(failed.rows[0]!.hidden, "failed");
  const quiet = subagentTree([agent("root"), agent("child", "root")], new Set(["root", "missing"]));
  assert.equal(quiet.rows[0]!.hidden, undefined);
  assert.equal(subagentTree([agent("leaf")], new Set(["leaf"])).rows[0]!.folded, false);
});

test("a very deep chain doesn't overflow the stack", () => {
  const chain = Array.from({ length: 2_000 }, (_, index) => agent(`a${index}`, index ? `a${index - 1}` : undefined));
  const { rows } = subagentTree(chain);
  assert.equal(rows.length, 2_000);
  assert.equal(rows.at(-1)!.depth, 1_999);
});

test("the counts keep failed apart from the rest that ended", () => {
  assert.deepEqual(
    subagentCounts([
      agent("a", undefined, "running"),
      agent("b", undefined, "waiting"),
      agent("c", undefined, "failed"),
      agent("d"),
      agent("e", undefined, "cancelled"),
      agent("f", undefined, "unknown"),
    ]),
    { running: 2, failed: 1, done: 2 },
  );
});
