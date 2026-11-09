import type { AgentTask, StepKind, SubagentProgress, SubagentTranscriptEntry, ToolCategory } from "./model.ts";

export type SubagentStep = { id: string; said: string; text: string; tools: Partial<Record<ToolCategory, number>>; lastTool?: string };

export function toolCategory(kind: StepKind | undefined, text: string): ToolCategory;
export function toolSummary(counts: Partial<Record<ToolCategory, number>> | undefined, limit?: number): string;
export function toolChips(counts: Partial<Record<ToolCategory, number>> | undefined): { category: ToolCategory; count: number; label: string }[];
export function plainTitle(text: string | undefined): string;
export function firstSentence(text: string | undefined): string;
export function isStep(entry: SubagentTranscriptEntry): boolean;
export function isToolCall(entry: SubagentTranscriptEntry): boolean;
export function addProgress(progress: SubagentProgress | undefined, entry: SubagentTranscriptEntry): SubagentProgress;
export function subagentSteps(transcript: SubagentTranscriptEntry[] | undefined): SubagentStep[];
export function lastSaid(steps: SubagentStep[]): string | undefined;
export function subagentOutcome(transcript: SubagentTranscriptEntry[] | undefined): string | undefined;
export function planCounts(tasks: AgentTask[] | undefined): { done: number; total: number } | null;
