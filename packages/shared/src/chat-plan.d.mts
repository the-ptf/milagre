import type { AgentTask, ChatPhase, ChatPlan, ChatTask, ChatTaskStatus } from "./model.ts";

export type TaskInput = { id?: string; title: string; activeForm?: string; status?: ChatTaskStatus; children?: TaskInput[] };
export const PHASES: readonly ChatPhase[];
export function deriveTasks(tasks: ChatTask[]): ChatTask[];
export function setTasks(plan: ChatPlan | undefined, input: TaskInput[], now: number): ChatPlan;
export function updateTask(
  plan: ChatPlan | undefined,
  change: { id: string; status?: ChatTaskStatus; title?: string; activeForm?: string },
  now: number,
): ChatPlan;
export function setPhase(plan: ChatPlan | undefined, phase: ChatPhase, now: number): ChatPlan;
export function nativePlan(plan: ChatPlan | undefined, tasks: AgentTask[], now: number): ChatPlan | undefined;
export function taskCounts(tasks: ChatTask[]): { done: number; total: number };
export function currentPhase(plan: ChatPlan | undefined): ChatPhase | undefined;
