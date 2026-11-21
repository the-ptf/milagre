const FREEZE_MS = 200;
const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

function summary(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    mean: round(mean),
    max: round(sorted[sorted.length - 1]),
  };
}

function stddev(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

/** Nearest palette entry within `limit` (Euclidean RGB distance), or -1. Serialized into the viewer page: no outside references. */
function nearestColour(rgb, palette, limit = 90) {
  let best = -1;
  let bestDistance = limit;
  for (let index = 0; index < palette.length; index++) {
    const [r, g, b] = palette[index];
    const distance = Math.sqrt((rgb[0] - r) ** 2 + (rgb[1] - g) ** 2 + (rgb[2] - b) ** 2);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * `frames` are painted viewer frames ({ paintedAt, hash }) in paint order; `previousHash` is the last hash before the window.
 * A changed frame differs from the one before it. On a moving screen every gap between changed frames over 200 ms is a freeze,
 * including the gaps from the window's start and to its end.
 */
function frameStats(frames, { from, to, moving, previousHash = null }) {
  const seconds = (to - from) / 1000;
  const inside = frames.filter((frame) => frame.paintedAt >= from && frame.paintedAt < to);
  let last = previousHash;
  const changed = [];
  for (const frame of inside) {
    if (frame.hash !== last) changed.push(frame);
    last = frame.hash;
  }
  const counted = moving ? changed : inside;
  const intervals = counted.slice(1).map((frame, index) => frame.paintedAt - counted[index].paintedAt);
  const gaps = moving && counted.length ? [counted[0].paintedAt - from, ...intervals, to - counted[counted.length - 1].paintedAt] : intervals;
  const freezes = moving ? (counted.length ? gaps.filter((gap) => gap > FREEZE_MS).length : 1) : null;
  return {
    paintedFps: round(inside.length / seconds),
    changedFps: round(changed.length / seconds),
    frameIntervalMs: summary(intervals),
    frameIntervalStddevMs: round(stddev(intervals)),
    freezesPerMinute: freezes === null ? null : round((freezes / seconds) * 60),
    longestGapMs: moving ? round(counted.length ? Math.max(...gaps) : to - from) : intervals.length ? round(Math.max(...intervals)) : null,
  };
}

function rates(before, after, seconds) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, round((value - (before[key] ?? 0)) / seconds)]));
}

module.exports = { FREEZE_MS, frameStats, nearestColour, percentile, rates, round, stddev, summary };
