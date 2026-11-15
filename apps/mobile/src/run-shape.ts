import type { AgentRun } from "@milagre/shared/agent-runs";
import { designActivity } from "@milagre/shared/artifact";
import { runStatusLabel } from "@milagre/shared/tool-activity";

/**
 * What the Chat screen reads of its streaming turn: whether one runs, what it waits on, and the few words and counts
 * drawn around the reply. A streamed batch moves the turn's text and steps on every read; this changes only as the turn
 * starts, asks, answers, switches mode or ends, so the screen around the reply renders only then (the reply reads the
 * whole turn itself, LiveReply in app/chat.tsx).
 */
export type RunShape = Pick<AgentRun, "turnId" | "startedAt" | "permissionMode" | "waitingForSubagents" | "approvals" | "questions" | "contextUsage"> & {
  /** Worktree creation or setup beside the running mark (runStatusLabel), or null. */
  status: string | null;
  /** The turn's resolved design comments so far (designActivity), so feedback cards read again only when it moves. */
  designActivity: number;
};

/** The shape of `run` now. */
export function runShape(run: AgentRun): RunShape {
  // A summary of a turn read for another screen can come without its steps.
  const steps = run.steps ?? [];
  return {
    turnId: run.turnId,
    startedAt: run.startedAt,
    permissionMode: run.permissionMode,
    waitingForSubagents: run.waitingForSubagents,
    approvals: run.approvals,
    questions: run.questions,
    contextUsage: run.contextUsage,
    status: runStatusLabel(steps),
    designActivity: designActivity(steps, []),
  };
}

// The runs store reuses an unchanged request or usage object from read to read (reconcileState), so identity is cheap and
// mostly enough; a list or a usage read again whole still counts as the same when every item is.
const sameItems = (a: readonly unknown[], b: readonly unknown[]) => a === b || (a.length === b.length && a.every((item, index) => item === b[index]));
const sameFields = (a: object | undefined, b: object | undefined) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof typeof a)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
};

/** Whether two shapes draw the same screen. */
export function sameRunShape(a: RunShape | undefined, b: RunShape | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.turnId === b.turnId &&
    a.startedAt === b.startedAt &&
    a.permissionMode === b.permissionMode &&
    a.waitingForSubagents === b.waitingForSubagents &&
    a.status === b.status &&
    a.designActivity === b.designActivity &&
    sameItems(a.approvals, b.approvals) &&
    sameItems(a.questions, b.questions) &&
    sameFields(a.contextUsage, b.contextUsage)
  );
}

/**
 * Picks a turn's shape for useSyncExternalStore: the same object for as long as the shape stays the same, so a reader
 * re-renders only when it changes. The same turn object skips the work entirely.
 */
export class RunShapeReader {
  private run: AgentRun | undefined;
  private shape: RunShape | undefined;
  pick(run: AgentRun | undefined): RunShape | undefined {
    if (run === this.run) return this.shape;
    this.run = run;
    const next = run ? runShape(run) : undefined;
    if (!sameRunShape(this.shape, next)) this.shape = next;
    return this.shape;
  }
}
