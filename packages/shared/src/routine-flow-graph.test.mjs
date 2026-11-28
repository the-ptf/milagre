import assert from "node:assert/strict";
import test from "node:test";
import { insertStep } from "./routine-flows.mjs";
import { layoutFlow, runPath } from "./routine-flow-graph.mjs";

const agent = (id, output = []) => ({
  id,
  name: id,
  kind: "agent",
  prompt: "",
  chat: "run",
  output: output.map((name) => ({ name, type: "text" })),
  retries: 0,
  onInvalid: "stop",
});
const ask = (id) => ({ id, name: id, kind: "ask", message: "", expiresInHours: 24 });
const when = (id, yes, otherwise) => ({ id, name: id, kind: "if", field: "plan.size", test: "is", value: "small", yes, otherwise });

const flow = () => [
  agent("plan", ["plan", "size"]),
  when(
    "small",
    [agent("implement", ["summary"]), when("green", [{ id: "pr", name: "pr", kind: "pull-request", title: "", body: "", draft: true }], [ask("fix")])],
    [ask("big")],
  ),
  ask("review"),
];

const byId = (graph, id) => graph.nodes.find((node) => node.id === id);
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("paths sit side by side, Yes on the left, and no two nodes overlap", () => {
  const graph = layoutFlow(flow());
  assert.ok(byId(graph, "implement").x < byId(graph, "big").x);
  assert.ok(byId(graph, "pr").x < byId(graph, "fix").x);
  assert.equal(byId(graph, "implement").y, byId(graph, "big").y);
  for (const [index, a] of graph.nodes.entries()) for (const b of graph.nodes.slice(index + 1)) assert.ok(!overlaps(a, b), `${a.id} overlaps ${b.id}`);
});

test("the step after an If starts below both of its paths", () => {
  const graph = layoutFlow(flow());
  const review = byId(graph, "review");
  for (const id of ["pr", "fix", "big"]) assert.ok(review.y > byId(graph, id).y + byId(graph, id).height);
  assert.ok(graph.merges.some((merge) => merge.id === "merge:small" && merge.y < review.y));
});

test("a folded path is one node counting its steps, and the layout narrows", () => {
  const open = layoutFlow(flow());
  const folded = layoutFlow(flow(), { collapsed: new Set(["small:yes"]) });
  const node = folded.nodes.find((entry) => entry.kind === "collapsed");
  assert.equal(node.id, "collapsed:small:yes");
  assert.equal(node.count, 4);
  assert.ok(!folded.nodes.some((entry) => entry.id === "implement"));
  assert.ok(folded.bounds.width < open.bounds.width);
  assert.equal(folded.edges.find((edge) => edge.kind === "merge" && edge.branch === "yes").where, null);
});

test("an edge's place inserts the new step exactly there", () => {
  const steps = flow();
  const graph = layoutFlow(steps);
  const into = graph.edges.find((edge) => edge.to.id === "fix");
  const added = insertStep(steps, into.where, ask("added"));
  assert.deepEqual(
    added[1].yes[1].otherwise.map((step) => step.id),
    ["added", "fix"],
  );
  const after = graph.edges.find((edge) => edge.kind === "merge" && edge.from.id === "big");
  assert.deepEqual(
    insertStep(steps, after.where, ask("tail"))[1].otherwise.map((step) => step.id),
    ["big", "tail"],
  );
  assert.deepEqual(insertStep(steps, graph.end.where, ask("last")).at(-1).id, "last");
});

test("an empty path gets a placeholder that adds to it", () => {
  const graph = layoutFlow([when("check", [ask("a")], [])]);
  const empty = graph.nodes.find((node) => node.kind === "empty");
  assert.deepEqual(empty.where, { parentId: "check", branch: "otherwise", index: 0 });
});

test("a Flow with no steps is just the trigger", () => {
  const graph = layoutFlow([]);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["trigger"],
  );
  assert.equal(graph.end.from.id, "trigger");
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.end.where, { parentId: null, branch: null, index: 0 });
});

test("runPath follows the side each If took and stops at the step under way", () => {
  const { reached, takenPaths } = runPath(flow(), {
    plan: { status: "done" },
    small: { status: "done", taken: "yes" },
    implement: { status: "running" },
  });
  assert.deepEqual(
    [...reached].filter((id) => !id.includes(":")),
    ["trigger", "plan", "small", "implement"],
  );
  assert.ok(!reached.has("merge:small"));
  assert.deepEqual([...takenPaths], ["small:yes"]);
  const done = runPath(flow(), {
    plan: { status: "done" },
    small: { status: "done", taken: "otherwise" },
    big: { status: "done" },
    review: { status: "waiting" },
  });
  assert.ok(done.reached.has("merge:small") && done.reached.has("review") && !done.reached.has("implement"));
  assert.ok(done.reached.has("collapsed:small:otherwise") && !done.reached.has("collapsed:small:yes"));
});
