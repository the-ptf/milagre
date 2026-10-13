import assert from "node:assert/strict";
import test from "node:test";
import { phaseGraph, phaseGraphPath, rowY } from "./phase-graph.mjs";

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
