import type { Subagent } from "./model.ts";

export interface SubagentCounts {
  total: number;
  running: number;
  waiting: number;
  failed: number;
  done: number;
}

export interface SubagentNode {
  agent: Subagent;
  /** Resolved visible parent; missing, archived, self and cyclic parent links become roots. */
  parentId?: string;
  children: SubagentNode[];
  /** The node itself and every descendant, including collapsed descendants. */
  counts: SubagentCounts;
}

export interface SubagentTree {
  roots: SubagentNode[];
  nodes: Map<string, SubagentNode>;
  counts: SubagentCounts;
  nested: boolean;
}

/** Excludes archived agents and keeps the first visible entry for each ID. Does not mutate its input. */
export function buildSubagentTree(agents: readonly Subagent[]): SubagentTree;
export function flattenSubagentTree(tree: SubagentTree, collapsed: ReadonlySet<string>): { node: SubagentNode; depth: number }[];
/** Root-first ancestor IDs, excluding the requested node; empty for a root or missing ID. */
export function subagentAncestors(tree: SubagentTree, id: string): string[];
export function subagentStatusLabel(status: Subagent["status"]): string;
