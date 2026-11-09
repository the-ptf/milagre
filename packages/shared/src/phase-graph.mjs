// Geometry for a Chat's phase graph: phase history to points on a 0..1 time axis that ends at Now, with stretches
// longer than `gapMs` drawn `gapMs` wide and labelled. Desktop and phone draw the same shapes with their own SVG.
import { PHASES } from "./chat-plan.mjs";

const HOUR = 3_600_000;
const defaultFormat = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function duration(ms) {
  return ms >= 48 * HOUR ? `${Math.round(ms / (24 * HOUR))}d` : `${Math.round(ms / HOUR)}h`;
}

export function phaseGraph(phases, now, { gapMs = HOUR, formatTime = defaultFormat } = {}) {
  if (!phases.length) return { points: [], nowX: 1, gaps: [], ticks: [] };
  const times = [...phases.map((entry) => entry.at), Math.max(now, phases.at(-1).at)];
  const widths = times.slice(1).map((at, index) => Math.min(Math.max(at - times[index], 0), gapMs));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const xs = [0];
  for (const width of widths) xs.push(xs.at(-1) + width);
  const x = (index) => (total > 0 ? xs[index] / total : 0);
  const points = phases.map((entry, index) => ({ x: x(index), row: PHASES.indexOf(entry.phase), phase: entry.phase, at: entry.at }));
  const gaps = [];
  for (let index = 0; index < times.length - 1; index++) {
    const length = times[index + 1] - times[index];
    if (length <= gapMs) continue;
    const last = index + 1 === times.length - 1;
    // `row` is the phase the gap starts in, `toRow` the one it ends in (the same when the gap runs on to Now).
    gaps.push({
      x0: x(index),
      x1: last ? 1 : x(index + 1),
      row: points[index].row,
      toRow: last ? points[index].row : points[index + 1].row,
      label: duration(length),
    });
  }
  const ticks = [];
  for (const point of points) {
    if (ticks.length && point.x - ticks.at(-1).x < 0.25) continue;
    if (point.x > 0.85) break;
    ticks.push({ x: point.x, label: formatTime(point.at) });
  }
  return { points, nowX: 1, gaps, ticks, current: phases.at(-1).phase };
}

/** The y of a phase row's centre, `start` (row 0) at the bottom. */
export function rowY(row, height) {
  const band = height / PHASES.length;
  return Number((height - (row + 0.5) * band).toFixed(2));
}

/** An S-curve from point to point, then flat to Now at the right edge. `left` shifts the plot right by that many pixels. */
export function phaseGraphPath(points, width, height, left = 0) {
  if (!points.length) return "";
  const at = (point) => [Number((left + point.x * width).toFixed(2)), rowY(point.row, height)];
  const [x0, y0] = at(points[0]);
  let d = `M${x0} ${y0}`;
  for (let index = 1; index < points.length; index++) {
    const [px, py] = at(points[index - 1]);
    const [nx, ny] = at(points[index]);
    const mid = Number(((px + nx) / 2).toFixed(2));
    d += ` C${mid} ${py}, ${mid} ${ny}, ${nx} ${ny}`;
  }
  return `${d} H${Number((left + width).toFixed(2))}`;
}

/**
 * Pixel positions for an SVG `width` x `height` wide: the plot sits between `insetLeft` and `insetRight` so the first dot
 * and the Now line are never cut, and the tick labels and "Now" stay inside the SVG (iOS ignores overflow: visible).
 * A tick label is `tickWidth` wide and "Now" is `nowWidth` wide; a tick that would run into the previous label or Now is dropped.
 */
export function phaseGraphLayout(graph, width, { height, insetLeft = 6, insetRight = 6, tickWidth = 44, nowWidth = 28 }) {
  const plotWidth = Math.max(width - insetLeft - insetRight, 0);
  const plotRight = insetLeft + plotWidth;
  const px = (x) => Number((insetLeft + x * plotWidth).toFixed(2));
  const last = graph.points.length - 1;
  const points = graph.points.map((point, index) => ({
    x: px(point.x),
    y: rowY(point.row, height),
    phase: point.phase,
    at: point.at,
    current: index === last,
  }));
  // The chip sits on the line at the middle of the gap: the S-curve crosses the average of its two rows there.
  const gaps = graph.gaps.map((gap) => ({
    x: px((gap.x0 + gap.x1) / 2),
    y: Number(((rowY(gap.row, height) + rowY(gap.toRow, height)) / 2).toFixed(2)),
    label: gap.label,
  }));
  const ticks = [];
  let freeFrom = 0;
  const nowStart = width - nowWidth - 2;
  for (const tick of graph.ticks) {
    const first = tick.x === 0;
    const x = first ? insetLeft : px(tick.x);
    const start = first ? x : x - tickWidth / 2;
    const end = first ? x + tickWidth : x + tickWidth / 2;
    if (start < freeFrom || end > nowStart) continue;
    ticks.push({ x, anchor: first ? "start" : "middle", label: tick.label });
    freeFrom = end + 4;
  }
  return {
    path: phaseGraphPath(graph.points, plotWidth, height, insetLeft),
    plotLeft: insetLeft,
    plotRight,
    points,
    gaps,
    ticks,
    // An end-anchored label can still overhang its anchor by a pixel (glyph side bearings), so it ends 2 px in.
    now: { x: width - 2, anchor: "end", lineX: plotRight },
  };
}
