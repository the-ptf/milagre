import type { ActivityEntry } from "./reply-parts";

const ACTIVITY_CAP = 200;
const ACTIVITY_PAGE = 150;

/** Fix the first-open boundary, lowering it only to keep running/waiting steps visible. */
export function activityBoundary(
  entries: ActivityEntry[],
  waitingStepIds: string[],
  boundary = entries.length > ACTIVITY_CAP ? entries.length - ACTIVITY_PAGE : 0,
) {
  const end = Math.min(boundary, entries.length);
  for (let index = 0; index < end; index++) {
    const entry = entries[index];
    if (entry?.type === "step" && (entry.step.status === "running" || waitingStepIds.includes(entry.step.id))) return index;
  }
  return end;
}

/** Count hidden tool steps; thinking and intervening text are revealed without inflating the label. */
export function earlierStepsLabel(entries: ActivityEntry[], hidden: number) {
  let steps = 0;
  let failed = 0;
  for (let index = 0; index < hidden; index++) {
    const entry = entries[index];
    if (entry?.type !== "step" || entry.step.kind === "thinking") continue;
    steps++;
    if (entry.step.status === "failed") failed++;
  }
  return `Show earlier steps (${steps.toLocaleString()}${failed ? `, ${failed.toLocaleString()} failed` : ""})`;
}
