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
    if (length > gapMs) gaps.push({ x0: x(index), x1: index + 1 === times.length - 1 ? 1 : x(index + 1), label: duration(length) });
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

/** An S-curve from point to point, then flat to Now at the right edge. */
export function phaseGraphPath(points, width, height) {
  if (!points.length) return "";
  const at = (point) => [Number((point.x * width).toFixed(2)), rowY(point.row, height)];
  const [x0, y0] = at(points[0]);
  let d = `M${x0} ${y0}`;
  for (let index = 1; index < points.length; index++) {
    const [px, py] = at(points[index - 1]);
    const [nx, ny] = at(points[index]);
    const mid = Number(((px + nx) / 2).toFixed(2));
    d += ` C${mid} ${py}, ${mid} ${ny}, ${nx} ${ny}`;
  }
  return `${d} H${width}`;
}
