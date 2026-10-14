import assert from "node:assert/strict";
import test from "node:test";
import { phaseGraph, phaseGraphLayout, phaseGraphPath, rowY } from "./phase-graph.mjs";

const HOUR = 3_600_000;
const format = (ms: number) => `t${ms / 60_000}`;

test("no entries draw nothing", () => {
  const graph = phaseGraph([], 10, { formatTime: format });
  assert.deepEqual(graph.points, []);
  assert.equal(graph.current, undefined);
});

test("one entry draws a flat line to Now", () => {
  const graph = phaseGraph([{ phase: "plan", at: 0 }], 0, { formatTime: format });
  assert.deepEqual(graph.points, [{ x: 0, row: 1, phase: "plan", at: 0 }]);
  assert.equal(graph.nowX, 1);
  assert.match(phaseGraphPath(graph.points, 100, 80), /^M0 \d+(\.\d+)? H100$/);
});

test("x follows time and the current phase is the last", () => {
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "plan", at: 10 * 60_000 },
      { phase: "build", at: 20 * 60_000 },
    ],
    40 * 60_000,
    { formatTime: format },
  );
  assert.deepEqual(
    graph.points.map((point) => point.x),
    [0, 0.25, 0.5],
  );
  assert.equal(graph.current, "build");
  assert.deepEqual(graph.gaps, []);
});

test("a stretch over an hour folds into a gap with its length", () => {
  const graph = phaseGraph(
    [
      { phase: "build", at: 0 },
      { phase: "test", at: 30 * 60_000 },
      { phase: "review", at: 30 * 60_000 + 2 * HOUR },
    ],
    30 * 60_000 + 2 * HOUR + 30 * 60_000,
    { formatTime: format },
  );
  assert.equal(graph.gaps.length, 1);
  assert.equal(graph.gaps[0].label, "2h");
  // The two-hour stretch is drawn one hour wide: 30m + 60m + 30m.
  assert.deepEqual(
    graph.points.map((point) => Number(point.x.toFixed(3))),
    [0, 0.25, 0.75],
  );
  assert.deepEqual([graph.gaps[0].x0, graph.gaps[0].x1], [0.25, 0.75]);
});

test("ticks label the first point and points at least a quarter apart", () => {
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "plan", at: 60_000 },
      { phase: "build", at: 20 * 60_000 },
      { phase: "test", at: 30 * 60_000 },
    ],
    40 * 60_000,
    { formatTime: format },
  );
  assert.deepEqual(
    graph.ticks.map((tick) => tick.label),
    ["t0", "t20", "t30"],
  );
});

test("rows run bottom to top and the path curves between points", () => {
  assert.ok(rowY(0, 80) > rowY(7, 80));
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "build", at: 60_000 },
    ],
    120_000,
    { formatTime: format },
  );
  assert.match(phaseGraphPath(graph.points, 100, 80), /^M0 [\d.]+ C[\d., ]+ H100$/);
});

const history = [
  { phase: "start", at: 0 },
  { phase: "plan", at: 20 * 60_000 },
  { phase: "build", at: 40 * 60_000 },
  { phase: "test", at: 60 * 60_000 },
  { phase: "review", at: 60 * 60_000 + 3 * HOUR },
] as const;
const sample = () => phaseGraph([...history], 60 * 60_000 + 4 * HOUR, { formatTime: format });

test("layout keeps the first tick, the dots and Now inside the box", () => {
  for (const width of [120, 200, 260, 340, 600]) {
    const layout = phaseGraphLayout(sample(), width, { height: 168 });
    assert.equal(layout.ticks[0].anchor, "start");
    assert.equal(layout.ticks[0].x, 6);
    assert.deepEqual(layout.now, { x: width, anchor: "end", lineX: width - 6 });
    for (const point of layout.points) assert.ok(point.x >= 6 && point.x <= width - 6, `${point.x} outside at ${width}`);
    assert.equal(layout.points[0].x, 6);
    assert.equal(layout.points.filter((point) => point.current).length, 1);
  }
});

test("layout drops ticks whose labels would cross an edge, a neighbour or Now", () => {
  for (const width of [90, 120, 200, 260, 340, 600]) {
    const { ticks } = phaseGraphLayout(sample(), width, { height: 168 });
    let free = 0;
    for (const tick of ticks) {
      const start = tick.anchor === "start" ? tick.x : tick.x - 22;
      const end = start + 44;
      assert.ok(start >= 0 && end <= width, `tick ${tick.label} crosses an edge at ${width}`);
      assert.ok(start >= free, `tick ${tick.label} overlaps the previous one at ${width}`);
      assert.ok(end <= width - 28, `tick ${tick.label} overlaps Now at ${width}`);
      free = end;
    }
  }
});

test("layout puts a gap chip on the line and the path starts at the left inset", () => {
  const layout = phaseGraphLayout(sample(), 300, { height: 168 });
  assert.equal(layout.gaps.length, 1);
  // The gap runs from test (row 3) to review (row 4): the S-curve crosses their average at the middle.
  assert.equal(layout.gaps[0].y, Number(((rowY(3, 168) + rowY(4, 168)) / 2).toFixed(2)));
  assert.match(layout.path, /^M6 /);
  assert.match(layout.path, / H294$/);
});

test("layout of a gap that runs on to Now sits at the row the Chat stayed in", () => {
  const graph = phaseGraph(
    [
      { phase: "build", at: 0 },
      { phase: "test", at: 60_000 },
    ],
    60_000 + 5 * HOUR,
    { formatTime: format },
  );
  const layout = phaseGraphLayout(graph, 300, { height: 168 });
  assert.equal(layout.gaps[0].y, rowY(3, 168));
});
