import type { FlowStep, FlowStepRun } from "./model.ts";

export interface FlowPlace {
  parentId: string | null;
  branch: "yes" | "otherwise" | null;
  index: number;
}

export interface FlowGraphPoint {
  id: string;
  x: number;
  y: number;
}

export type FlowGraphNode =
  | { id: "trigger"; kind: "trigger"; x: number; y: number; width: number; height: number }
  | { id: string; kind: "step"; step: FlowStep; where: FlowPlace; x: number; y: number; width: number; height: number }
  | { id: string; kind: "condition"; step: Extract<FlowStep, { kind: "if" }>; where: FlowPlace; x: number; y: number; width: number; height: number }
  | { id: string; kind: "empty" | "collapsed"; count: number; where: FlowPlace; x: number; y: number; width: number; height: number };

export interface FlowGraphEdge {
  id: string;
  kind: "next" | "path" | "merge";
  from: FlowGraphPoint;
  to: FlowGraphPoint;
  branch: "yes" | "otherwise" | null;
  where: FlowPlace | null;
}

export interface FlowGraphSizes {
  step: { width: number; height: number };
  condition: { height: number };
  empty: { width: number; height: number };
  gapY: number;
  gapX: number;
  pathGap: number;
  mergeGap: number;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  merges: FlowGraphPoint[];
  end: FlowGraphPoint & { from: FlowGraphPoint; where: FlowPlace };
  bounds: { x: number; y: number; width: number; height: number };
}

export function layoutFlow(steps: FlowStep[], options?: { sizes?: Partial<FlowGraphSizes>; collapsed?: ReadonlySet<string> }): FlowGraph;
export function runPath(steps: FlowStep[], state: Record<string, FlowStepRun> | undefined): { reached: Set<string>; takenPaths: Set<string> };
