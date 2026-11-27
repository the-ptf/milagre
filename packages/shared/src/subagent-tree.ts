import type { Subagent } from "./model.ts";
import { subagentActive } from "./agent-runs.mjs";

export type SubagentTreeRow = {
  agent: Subagent;
  depth: number;
  /** The listed subagent that started this one; absent at the top level. */
  parent?: string;
  /** How many listed subagents this one started. */
  children: number;
  folded: boolean;
  /** Last of its parent's subagents, so the parent's guide line ends at this row. */
  last: boolean;
  /** One per level between the top and this row's parent: whether that level's guide line runs on past this row. */
  rails: boolean[];
  /** The loudest state inside a folded branch. */
  hidden?: "running" | "failed";
};

type Step = { agent: Subagent; depth: number; parent?: string; last: boolean; rails: boolean[] };

/**
 * A Chat's subagents as rows of the tree of who started whom, in start order. A subagent whose parent isn't listed
 * (unknown, archived, itself) sits at the top; a cycle is broken at its first listed member.
 */
export function subagentTree(agents: readonly Subagent[], folded: ReadonlySet<string> = new Set()): { rows: SubagentTreeRow[]; nested: boolean } {
  const byId = new Map<string, Subagent>();
  for (const agent of agents) if (!byId.has(agent.id)) byId.set(agent.id, agent);
  const children = new Map<string, Subagent[]>();
  for (const agent of byId.values()) {
    if (!agent.parentId || agent.parentId === agent.id || !byId.has(agent.parentId)) continue;
    const siblings = children.get(agent.parentId);
    if (siblings) siblings.push(agent);
    else children.set(agent.parentId, [agent]);
  }
  const seen = new Set<string>();
  const rows: SubagentTreeRow[] = [];
  const unseenChildren = (id: string) => (children.get(id) ?? []).filter((child) => !seen.has(child.id));
  const fold = (id: string): SubagentTreeRow["hidden"] => {
    let hidden: SubagentTreeRow["hidden"];
    const stack = unseenChildren(id);
    for (const agent of stack) seen.add(agent.id);
    while (stack.length) {
      const agent = stack.pop()!;
      if (agent.status === "failed") hidden = "failed";
      else if (!hidden && subagentActive(agent)) hidden = "running";
      for (const child of unseenChildren(agent.id)) {
        seen.add(child.id);
        stack.push(child);
      }
    }
    return hidden;
  };
  const walk = (start: Subagent) => {
    const stack: Step[] = [{ agent: start, depth: 0, last: true, rails: [] }];
    while (stack.length) {
      const { agent, depth, parent, last, rails } = stack.pop()!;
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      const kids = unseenChildren(agent.id);
      const row: SubagentTreeRow = { agent, depth, ...(parent ? { parent } : {}), children: kids.length, folded: false, last, rails };
      rows.push(row);
      if (!kids.length) continue;
      if (folded.has(agent.id)) {
        row.folded = true;
        const hidden = fold(agent.id);
        if (hidden) row.hidden = hidden;
        continue;
      }
      const childRails = depth ? [...rails, !last] : [];
      for (let index = kids.length - 1; index >= 0; index--)
        stack.push({ agent: kids[index]!, depth: depth + 1, parent: agent.id, last: index === kids.length - 1, rails: childRails });
    }
  };
  for (const agent of byId.values()) if (!agent.parentId || agent.parentId === agent.id || !byId.has(agent.parentId)) walk(agent);
  for (const agent of byId.values()) if (!seen.has(agent.id)) walk(agent);
  return { rows, nested: rows.some((row) => row.children > 0) };
}

/** The header's counts: failed ones apart from the rest that ended. */
export function subagentCounts(agents: readonly Subagent[]): { running: number; failed: number; done: number } {
  let running = 0;
  let failed = 0;
  let done = 0;
  for (const agent of agents) {
    if (subagentActive(agent)) running++;
    else if (agent.status === "failed") failed++;
    else if (agent.status === "completed" || agent.status === "cancelled") done++;
  }
  return { running, failed, done };
}
