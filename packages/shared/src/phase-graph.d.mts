import type { ChatPhase, ChatPhaseEntry } from "./model.ts";

export interface PhaseGraph {
  points: { x: number; row: number; phase: ChatPhase; at: number }[];
  nowX: 1;
  gaps: { x0: number; x1: number; label: string }[];
  ticks: { x: number; label: string }[];
  current?: ChatPhase;
}
export function phaseGraph(phases: ChatPhaseEntry[], now: number, options?: { gapMs?: number; formatTime?: (ms: number) => string }): PhaseGraph;
export function rowY(row: number, height: number): number;
export function phaseGraphPath(points: PhaseGraph["points"], width: number, height: number): string;
