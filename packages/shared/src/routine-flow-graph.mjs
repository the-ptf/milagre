import { flattenSteps } from "./routine-flows.mjs";

const DEFAULT_SIZES = Object.freeze({
  step: { width: 264, height: 64 },
  condition: { height: 40 },
  empty: { width: 168, height: 28 },
  gapY: 72,
  gapX: 56,
  pathGap: 56,
  mergeGap: 32,
});

const pathKey = (ifId, branch) => `${ifId}:${branch}`;

/**
 * Lays a Flow's steps out top to bottom under the trigger: an If's paths sit side by side (Yes left, Otherwise right)
 * and join again under the longer one. Positions come only from the steps, so nothing is stored. Each node and edge
 * names the place a step added there would go (`where`), in the shape `insertStep` takes. A path in `collapsed`
 * (`"<ifId>:yes"`) shows as one node counting its steps.
 */
export function layoutFlow(steps, options = {}) {
  const sizes = { ...DEFAULT_SIZES, ...options.sizes };
  const collapsed = options.collapsed ?? new Set();
  const nodes = [];
  const edges = [];
  const merges = [];

  const columnWidth = (list, key) => {
    if (list.length === 0 || (key && collapsed.has(key))) return sizes.empty.width;
    let width = sizes.step.width;
    for (const step of list) {
      if (step.kind === "if")
        width = Math.max(width, columnWidth(step.yes, pathKey(step.id, "yes")) + sizes.gapX + columnWidth(step.otherwise, pathKey(step.id, "otherwise")));
    }
    return width;
  };

  const place = (list, centerX, top, from, where) => {
    const key = where.parentId ? pathKey(where.parentId, where.branch) : null;
    if (list.length === 0 || (key && collapsed.has(key))) {
      const folded = list.length > 0;
      const id = `${folded ? "collapsed" : "empty"}:${key}`;
      const node = {
        id,
        kind: folded ? "collapsed" : "empty",
        count: folded ? flattenSteps(list).length : 0,
        where: { ...where, index: folded ? list.length : 0 },
        x: centerX - sizes.empty.width / 2,
        y: top,
        width: sizes.empty.width,
        height: sizes.empty.height,
      };
      nodes.push(node);
      edges.push({ id: `${from.id}->${id}`, kind: "path", from, to: { id, x: centerX, y: top }, branch: where.branch, where: null });
      return { bottom: top + node.height, last: { id, x: centerX, y: top + node.height } };
    }
    let y = top;
    let previous = from;
    let bottom = top;
    for (const [index, step] of list.entries()) {
      const placeAt = { ...where, index };
      const condition = step.kind === "if";
      const height = condition ? sizes.condition.height : sizes.step.height;
      nodes.push({
        id: step.id,
        kind: condition ? "condition" : "step",
        step,
        where: placeAt,
        x: centerX - sizes.step.width / 2,
        y,
        width: sizes.step.width,
        height,
      });
      edges.push({
        id: `${previous.id}->${step.id}`,
        kind: index === 0 && where.parentId ? "path" : "next",
        from: previous,
        to: { id: step.id, x: centerX, y },
        branch: index === 0 ? where.branch : null,
        where: placeAt,
      });
      if (!condition) {
        previous = { id: step.id, x: centerX, y: y + height };
        bottom = y + height;
        y = bottom + sizes.gapY;
        continue;
      }
      const yesKey = pathKey(step.id, "yes");
      const otherwiseKey = pathKey(step.id, "otherwise");
      const yesWidth = columnWidth(step.yes, yesKey);
      const otherwiseWidth = columnWidth(step.otherwise, otherwiseKey);
      const total = yesWidth + sizes.gapX + otherwiseWidth;
      const yesX = centerX - total / 2 + yesWidth / 2;
      const otherwiseX = centerX + total / 2 - otherwiseWidth / 2;
      const pathTop = y + height + sizes.pathGap;
      const out = { x: centerX, y: y + height };
      const yes = place(step.yes, yesX, pathTop, { ...out, id: step.id }, { parentId: step.id, branch: "yes" });
      const otherwise = place(step.otherwise, otherwiseX, pathTop, { ...out, id: step.id }, { parentId: step.id, branch: "otherwise" });
      const mergeY = Math.max(yes.bottom, otherwise.bottom) + sizes.mergeGap;
      const merge = { id: `merge:${step.id}`, x: centerX, y: mergeY };
      merges.push(merge);
      for (const [branch, end, list, folded] of [
        ["yes", yes, step.yes, collapsed.has(yesKey)],
        ["otherwise", otherwise, step.otherwise, collapsed.has(otherwiseKey)],
      ]) {
        edges.push({
          id: `${end.last.id}->${merge.id}`,
          kind: "merge",
          from: end.last,
          to: merge,
          branch,
          where: list.length && !folded ? { parentId: step.id, branch, index: list.length } : null,
        });
      }
      previous = merge;
      bottom = mergeY;
      y = mergeY + sizes.gapY;
    }
    return { bottom, last: previous };
  };

  nodes.push({ id: "trigger", kind: "trigger", x: -sizes.step.width / 2, y: 0, width: sizes.step.width, height: sizes.step.height });
  const list = Array.isArray(steps) ? steps : [];
  const body = list.length
    ? place(list, 0, sizes.step.height + sizes.gapY, { id: "trigger", x: 0, y: sizes.step.height }, { parentId: null, branch: null })
    : { bottom: sizes.step.height, last: { id: "trigger", x: 0, y: sizes.step.height } };
  const end = { id: "end", x: 0, y: body.bottom + sizes.gapY / 2, from: body.last, where: { parentId: null, branch: null, index: list.length } };
  const width = Math.max(sizes.step.width, columnWidth(list, null));
  return { nodes, edges, merges, end, bounds: { x: -width / 2, y: 0, width, height: end.y } };
}

/**
 * Where a Run went: every node it reached (steps, Ifs, folded or empty paths, joins) and each path an If took
 * (`"<ifId>:yes"`). It stops at the first step not yet done, so the step under way is the last one reached.
 */
export function runPath(steps, state) {
  const reached = new Set(["trigger"]);
  const takenPaths = new Set();
  const walk = (list) => {
    for (const step of list) {
      const run = state?.[step.id];
      if (!run || run.status === "pending" || run.status === "not-run") return false;
      reached.add(step.id);
      if (step.kind !== "if") {
        if (run.status !== "done" && run.status !== "skipped") return false;
        continue;
      }
      const taken = run.taken;
      if (taken !== "yes" && taken !== "otherwise") return false;
      const key = pathKey(step.id, taken);
      takenPaths.add(key);
      reached.add(`empty:${key}`);
      reached.add(`collapsed:${key}`);
      if (!walk(step[taken])) return false;
      reached.add(`merge:${step.id}`);
    }
    return true;
  };
  walk(Array.isArray(steps) ? steps : []);
  return { reached, takenPaths };
}
