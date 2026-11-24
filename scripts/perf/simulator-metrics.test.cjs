const test = require("node:test");
const assert = require("node:assert/strict");
const { frameStats, nearestColour, summary } = require("./simulator-metrics.cjs");

const PALETTE = [
  [224, 0, 0],
  [0, 176, 0],
  [0, 48, 255],
  [255, 255, 255],
];

test("summary interpolates percentiles over sorted samples", () => {
  assert.deepEqual(summary([40, 10, 30, 20]), { n: 4, p50: 25, p95: 38.5, p99: 39.7, mean: 25, max: 40 });
  assert.equal(summary([]), null);
});

test("a JPEG-shifted tile colour still matches its palette entry, and anything far from the palette doesn't", () => {
  assert.equal(nearestColour([210, 18, 12], PALETTE), 0);
  assert.equal(nearestColour([240, 244, 250], PALETTE), 3);
  assert.equal(nearestColour([128, 128, 128], PALETTE), -1);
});

test("on a moving screen a repeated frame doesn't count as new, and each gap over 200 ms is a freeze", () => {
  const frames = [0, 50, 100, 400, 450, 450, 760, 800].map((paintedAt, index) => ({ paintedAt, hash: index === 5 ? 4 : index }));
  const stats = frameStats(frames, { from: 0, to: 1000, moving: true, previousHash: -1 });
  assert.equal(stats.paintedFps, 8);
  assert.equal(stats.changedFps, 7);
  assert.equal(stats.freezesPerMinute, 120);
  assert.equal(stats.longestGapMs, 310);
});

test("a moving screen that never changes is one freeze across the whole window", () => {
  const frames = [100, 300, 500].map((paintedAt) => ({ paintedAt, hash: 7 }));
  const stats = frameStats(frames, { from: 0, to: 2000, moving: true, previousHash: 7 });
  assert.equal(stats.changedFps, 0);
  assert.equal(stats.freezesPerMinute, 30);
  assert.equal(stats.longestGapMs, 2000);
});

test("a still screen counts every painted frame and reports no freezes", () => {
  const frames = [0, 200, 400, 600, 800, 1200].map((paintedAt) => ({ paintedAt, hash: 1 }));
  const stats = frameStats(frames, { from: 0, to: 1000, moving: false, previousHash: 1 });
  assert.equal(stats.paintedFps, 5);
  assert.equal(stats.changedFps, 0);
  assert.equal(stats.freezesPerMinute, null);
  assert.equal(stats.frameIntervalMs.p50, 200);
});
