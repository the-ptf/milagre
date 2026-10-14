import type { ChatPhase, ChatPhaseEntry } from "./model.ts";

export interface PhaseGraph {
  points: { x: number; row: number; phase: ChatPhase; at: number }[];
  nowX: 1;
  gaps: { x0: number; x1: number; row: number; toRow: number; label: string }[];
  ticks: { x: number; label: string }[];
  current?: ChatPhase;
}
export function phaseGraph(phases: ChatPhaseEntry[], now: number, options?: { gapMs?: number; formatTime?: (ms: number) => string }): PhaseGraph;
export function rowY(row: number, height: number): number;
export function phaseGraphPath(points: PhaseGraph["points"], width: number, height: number, left?: number): string;
export interface PhaseGraphLayout {
  path: string;
  plotLeft: number;
  plotRight: number;
  points: { x: number; y: number; phase: ChatPhase; at: number; current: boolean }[];
  gaps: { x: number; y: number; label: string }[];
  ticks: { x: number; anchor: "start" | "middle"; label: string }[];
  now: { x: number; anchor: "end"; lineX: number };
}
export function phaseGraphLayout(
  graph: PhaseGraph,
  width: number,
  options: { height: number; insetLeft?: number; insetRight?: number; tickWidth?: number; nowWidth?: number },
): PhaseGraphLayout;
