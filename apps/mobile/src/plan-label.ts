import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPhase, ChatPlan } from "@milagre/shared/model";

export const PHASE_LABELS: Record<ChatPhase, string> = {
  start: "Start",
  plan: "Plan",
  build: "Build",
  test: "Test",
  review: "Review",
  merge: "Merge",
  release: "Release",
  done: "Done",
};

/** The composer pill's text: done/total over leaf tasks, else the current phase; null hides the pill. */
export function planPillLabel(plan: ChatPlan | undefined): string | null {
  if (!plan) return null;
  const { done, total } = taskCounts(plan.tasks);
  if (total) return `${done}/${total}`;
  const phase = currentPhase(plan);
  return phase ? PHASE_LABELS[phase] : null;
}
