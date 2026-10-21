// The same hierarchy drives the desktop cards and phone outline. Input order is the sibling order, so live updates
// change the contents of a node without moving its place. The Chat's own agent is a UI root, outside these counts.

const emptyCounts = () => ({ total: 0, running: 0, waiting: 0, failed: 0, done: 0 });
const statusLabels = {
  initializing: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  unknown: "Status unavailable",
};

export function subagentStatusLabel(status) {
  return statusLabels[status] ?? statusLabels.unknown;
}

export function buildSubagentTree(agents) {
  const nodes = new Map();
  for (const agent of agents) {
    if (agent.archived || nodes.has(agent.id)) continue;
    const counts = emptyCounts();
    counts.total = 1;
    if (agent.status === "initializing" || agent.status === "running") counts.running = 1;
    else if (agent.status === "waiting") counts.waiting = 1;
    else if (agent.status === "failed") counts.failed = 1;
    else if (agent.status === "completed" || agent.status === "cancelled") counts.done = 1;
    nodes.set(agent.id, { agent, children: [], counts });
  }
  for (const node of nodes.values()) {
    const parentId = node.agent.parentId;
    if (parentId !== undefined && parentId !== node.agent.id && nodes.has(parentId)) node.parentId = parentId;
  }

  // Following parents is a functional graph: each walk either reaches a resolved path, a root, or its own cycle.
  // Detach every member of a cycle, keeping valid descendants attached to those now-root nodes.
  const settled = new Set();
  for (const start of nodes.values()) {
    if (settled.has(start.agent.id)) continue;
    const path = [];
    const positions = new Map();
    let node = start;
    while (node && !settled.has(node.agent.id) && !positions.has(node.agent.id)) {
      positions.set(node.agent.id, path.length);
      path.push(node);
      node = node.parentId === undefined ? undefined : nodes.get(node.parentId);
    }
    if (node && positions.has(node.agent.id)) {
      for (let index = positions.get(node.agent.id); index < path.length; index++) delete path[index].parentId;
    }
    for (const visited of path) settled.add(visited.agent.id);
  }

  const roots = [];
  let nested = false;
  for (const node of nodes.values()) {
    if (node.parentId === undefined) roots.push(node);
    else {
      nodes.get(node.parentId).children.push(node);
      nested = true;
    }
  }
  const tree = { roots, nodes, counts: emptyCounts(), nested };
  const rows = flattenSubagentTree(tree, new Set());
  // Reverse preorder visits every descendant before its parent. No recursion, even for provider-created deep chains.
  for (let index = rows.length - 1; index >= 0; index--) {
    const node = rows[index].node;
    const target = node.parentId === undefined ? tree.counts : nodes.get(node.parentId).counts;
    for (const name of Object.keys(target)) target[name] += node.counts[name];
  }
  return tree;
}

/** Visible preorder rows; collapsing affects presentation, never the branch's rolled-up counts. */
export function flattenSubagentTree(tree, collapsed) {
  const rows = [];
  const stack = [];
  for (let index = tree.roots.length - 1; index >= 0; index--) stack.push({ node: tree.roots[index], depth: 0 });
  while (stack.length) {
    const row = stack.pop();
    rows.push(row);
    if (collapsed.has(row.node.agent.id)) continue;
    for (let index = row.node.children.length - 1; index >= 0; index--) {
      stack.push({ node: row.node.children[index], depth: row.depth + 1 });
    }
  }
  return rows;
}

/** Ancestors from the outermost parent to the immediate parent, excluding the requested node. */
export function subagentAncestors(tree, id) {
  const ancestors = [];
  let node = tree.nodes.get(id);
  while (node?.parentId !== undefined) {
    ancestors.push(node.parentId);
    node = tree.nodes.get(node.parentId);
  }
  // oxlint-disable-next-line unicorn/no-array-reverse -- Hermes has no toReversed; this is a fresh local array.
  return ancestors.reverse();
}
