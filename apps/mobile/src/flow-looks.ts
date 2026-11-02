import {
  AlarmClockOffIcon,
  BotIcon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Comment01Icon,
  DashedLineCircleIcon,
  FlashIcon,
  GitForkIcon,
  GitPullRequestIcon,
  HourglassIcon,
  MinusSignCircleIcon,
  PauseCircleIcon,
  SecurityCheckIcon,
  StopCircleIcon,
  UnavailableIcon,
} from "@hugeicons/core-free-icons";
import { clock, runDuration, runTitle } from "@milagre/shared/routines";
import { durationText, flattenSteps, flowRunText, needsAnswer, stepSubtitle, type FlowRunRow } from "@milagre/shared/routine-flows";
import type { FlowStep, FlowStepKind, FlowStepRun, Routine, RoutineRun, RoutineTrigger } from "@milagre/shared/model";
import type { IconData, Tone } from "./icons";

/** A step type's icon and the colors of its tile: the icon's tone and the tile's fill (a palette key). */
export type StepLook = { icon: IconData; tone: Tone; tint: Tone };

const LOOKS: Record<FlowStepKind, StepLook> = {
  agent: { icon: BotIcon, tone: "accent", tint: "accentTint" },
  if: { icon: GitForkIcon, tone: "ink2", tint: "field" },
  ask: { icon: SecurityCheckIcon, tone: "orange", tint: "orangeTint" },
  wait: { icon: HourglassIcon, tone: "purple", tint: "purpleTint" },
  "pull-request": { icon: GitPullRequestIcon, tone: "green", tint: "greenTint" },
  "linear-comment": { icon: Comment01Icon, tone: "green", tint: "greenTint" },
};

/** How a step type looks in the editor and the Run view, as desktop draws it. */
export const stepLook = (kind: FlowStepKind): StepLook => LOOKS[kind] ?? LOOKS.agent;
/** The trigger's card: a flash on purple. */
export const TRIGGER_LOOK: StepLook = { icon: FlashIcon, tone: "purple", tint: "purpleTint" };

/** The trigger card's title: "Linear label added", "On a schedule", "Webhook". */
export function triggerTitle(trigger: RoutineTrigger | { kind: string }): string {
  if (trigger.kind === "schedule") return "On a schedule";
  if (trigger.kind === "webhook") return "Webhook";
  if (trigger.kind !== "linear") return "Trigger";
  const event = (trigger as Extract<RoutineTrigger, { kind: "linear" }>).event;
  if (event === "label-added") return "Linear label added";
  if (event === "assigned") return "Linear issue assigned";
  if (event === "state") return "Linear issue moved";
  return "Linear comment";
}

/** A step without the paths an If holds, so an If doesn't count as changed when only a step under it did. */
const own = (step: FlowStep) => {
  if (step.kind !== "if") return JSON.stringify(step);
  const { yes: _yes, otherwise: _otherwise, ...rest } = step;
  return JSON.stringify(rest);
};

/** The ids of the steps a draft adds, changes or moves, against the published steps: the editor marks them with a dot. */
export function changedStepIds(published: FlowStep[], draft: FlowStep[]): Set<string> {
  const before = new Map(flattenSteps(published).map((entry) => [entry.step.id, entry]));
  const changed = new Set<string>();
  for (const entry of flattenSteps(draft)) {
    const old = before.get(entry.step.id);
    if (!old || own(old.step) !== own(entry.step) || old.parentId !== entry.parentId || old.branch !== entry.branch || old.index !== entry.index)
      changed.add(entry.step.id);
  }
  return changed;
}

/**
 * A Run's number, as "Run 14": counted from the Routine's Run count, newest first, Test runs left out (they never count).
 * Null for a Test run.
 */
export function runNumber(routine: Pick<Routine, "runCount"> & { runs?: RoutineRun[] }, run: RoutineRun): number | null {
  if (run.flow?.dryRun) return null;
  const counted = (routine.runs ?? []).filter((item) => !item.flow?.dryRun).sort((a, b) => b.startedAt - a.startedAt);
  const newer = counted.findIndex((item) => item.id === run.id);
  if (newer < 0) return null;
  const total = Math.max(routine.runCount ?? 0, counted.length);
  return total - newer;
}

/** "Run 14", or "Test run". */
export function runName(routine: Pick<Routine, "runCount"> & { runs?: RoutineRun[] }, run: RoutineRun) {
  const number = runNumber(routine, run);
  return number === null ? "Test run" : `Run ${number}`;
}

/** Where a flow Run stands, for its icon, color and filter. */
export type FlowRunState = "you" | "running" | "waiting" | "paused" | "failed" | "ended" | "done";

export function flowRunState(run: RoutineRun): FlowRunState {
  const flow = run.flow;
  if (!flow) {
    if (run.status === "running") return "running";
    if (run.status === "failed") return "failed";
    if (run.status === "ended") return "ended";
    return "done";
  }
  if (needsAnswer(run)) return "you";
  if (flow.status === "paused") return "paused";
  if (flow.status === "waiting") return "waiting";
  if (flow.status === "running") return "running";
  if (flow.status === "failed") return "failed";
  if (flow.status === "ended") return "ended";
  return "done";
}

/** The Runs filter: a Run needs you while it waits for an answer or is paused; it stopped when a step failed. */
export type FlowRunFilter = "all" | "you" | "stopped";
export function flowRunMatches(run: RoutineRun, filter: FlowRunFilter) {
  if (filter === "all") return true;
  const state = flowRunState(run);
  return filter === "you" ? state === "you" || state === "paused" : state === "failed";
}

/** A Run's title: its Linear issue ("MIL-482 Retry webhook deliveries"), what it did, else the Routine's name. */
export const flowRunTitle = (run: RoutineRun, routineName: string) => runTitle(run, routineName);

/** "Linear label added", "agent added by Victor at 10:02": the trigger row of a Run's timeline. */
export function triggerRunLine(run: RoutineRun) {
  const event = run.event;
  const at = clock(run.startedAt);
  if (event?.kind === "linear") {
    if (event.change === "label-added") return `Label added at ${at}`;
    if (event.change === "comment") return event.comment?.author ? `Comment by ${event.comment.author} at ${at}` : `New comment at ${at}`;
    if (event.change === "assigned") return `Assigned at ${at}`;
    return event.issue.state ? `Moved to ${event.issue.state} at ${at}` : `Moved at ${at}`;
  }
  if (event?.kind === "webhook") return `Delivery at ${at}`;
  return `Started at ${at}`;
}

const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";

/** What a step's row in a Run's timeline says under its name. `now` moves "running for" and "ends in" on. */
export function stepRunLine(row: Extract<FlowRunRow, { kind: "step" }>, now: number): string {
  const { step, status, run } = row;
  if (status === "not-taken") return "Not taken";
  if (status === "not-run") return "Did not run";
  if (status === "skipped") return run?.summary?.trim() || "Skipped";
  if (status === "pending" || !run) return stepSubtitle(step);
  const approval = run.approval;
  if (approval?.decision === "expired") return `Expired after ${Math.max(1, Math.round((approval.expiresAt - approval.askedAt) / 3_600_000))} h`;
  if (approval?.decision === "rejected") return approval.reason ? `Rejected: ${approval.reason}` : "Rejected";
  if (status === "failed") {
    const tries = (run.tries?.length ?? 0) + 1;
    const error = firstLine(run.error);
    return tries > 1 ? `Failed ${tries} times${error ? `, ${error}` : ""}` : error || "Failed";
  }
  if (status === "waiting") {
    if (approval && !approval.decision) {
      if (step.kind === "pull-request") return `Waiting for you since ${clock(approval.askedAt)}`;
      const left = Math.max(1, Math.ceil((approval.expiresAt - Math.max(now, approval.askedAt)) / 3_600_000));
      return `No answer in ${left} h ends the Run`;
    }
    if (step.kind === "wait") {
      if (step.until.kind === "time") return run.waitUntil ? `Waits until ${clock(run.waitUntil)}` : `Waits ${durationText(step.until.minutes)}`;
      const until = run.waitUntil ? `, up to ${clock(run.waitUntil)}` : "";
      return step.until.kind === "linear-state" ? `Waiting for ${step.until.state}${until}` : `Waiting for a review${until}`;
    }
    return "Waiting";
  }
  if (status === "running") {
    const since = run.startedAt !== undefined ? ` for ${runDuration(now - run.startedAt)}` : "";
    return step.kind === "agent" ? `Running${since}${step.chat === "own" ? " in its own Chat" : ""}` : `Running${since}`;
  }
  // Done.
  if (step.kind === "if") return run.taken === "yes" ? "Took Yes" : run.taken === "otherwise" ? "Took Otherwise" : "Done";
  const receipt = run.receipt;
  if (receipt?.kind === "pull-request") {
    const what = `${receipt.draft ? "draft " : ""}#${receipt.number}`;
    return receipt.matched ? `Found ${what} by branch, receipt kept` : `Opened ${what} at ${clock(receipt.at)}, receipt kept`;
  }
  if (receipt?.kind === "linear-comment") return `Posted to ${receipt.issue} at ${clock(receipt.at)}`;
  if (approval?.decision === "approved") return `Approved at ${clock(approval.decidedAt ?? approval.askedAt)}`;
  if (run.summary?.trim()) return run.summary.trim();
  if (step.kind === "agent") {
    return run.startedAt !== undefined && run.endedAt !== undefined ? `Done in ${runDuration(run.endedAt - run.startedAt)}` : "Done";
  }
  return "Done";
}

/** An agent step's output as chips: "complexity: large". Long texts are left out. */
export function outputChips(output: Record<string, string | number | boolean> | undefined): string[] {
  if (!output) return [];
  return Object.entries(output)
    .filter(([, value]) => typeof value !== "string" || value.length <= 40)
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`);
}

/** The flow Runs going on: still running, waiting or paused, Test runs left out. */
export function runsInProgress(runs: RoutineRun[] | undefined) {
  return (runs ?? []).filter((run) => run.flow && !run.flow.dryRun && ["running", "waiting", "paused"].includes(run.flow.status));
}

/** The changes line's icon kind: added, removed, or changed. */
export const changeKind = (line: string): "added" | "removed" | "changed" =>
  line.startsWith("Added ") ? "added" : line.startsWith("Removed ") ? "removed" : "changed";

/** A Run's icon and its tone; no icon while it runs (the list draws a spinner). An approval that expired shows a clock. */
export function runStateLook(run: RoutineRun): { icon: IconData | null; tone: Tone } {
  const state = flowRunState(run);
  if (state === "you") return { icon: PauseCircleIcon, tone: "orange" };
  if (state === "paused") return { icon: PauseCircleIcon, tone: "ink2" };
  if (state === "waiting") return { icon: HourglassIcon, tone: "ink2" };
  if (state === "running") return { icon: null, tone: "accent" };
  if (state === "failed") return { icon: CancelCircleIcon, tone: "red" };
  if (state === "ended") return { icon: /expired/i.test(run.error ?? "") ? AlarmClockOffIcon : StopCircleIcon, tone: "ink2" };
  return { icon: CheckmarkCircle02Icon, tone: "green" };
}

/** A step's icon in a Run's timeline: a tick when done, a pause while it waits, a dashed ring before it starts. */
export function stepStateLook(status: FlowStepRun["status"] | "not-taken", run: FlowStepRun | null): { icon: IconData | null; tone: Tone } {
  if (run?.approval?.decision === "expired") return { icon: AlarmClockOffIcon, tone: "ink2" };
  if (run?.approval?.decision === "rejected") return { icon: UnavailableIcon, tone: "ink2" };
  if (status === "done") return { icon: CheckmarkCircle02Icon, tone: "green" };
  if (status === "running") return { icon: null, tone: "accent" };
  if (status === "waiting") return { icon: run?.approval ? PauseCircleIcon : HourglassIcon, tone: "orange" };
  if (status === "failed") return { icon: CancelCircleIcon, tone: "red" };
  if (status === "pending") return { icon: DashedLineCircleIcon, tone: "ink3" };
  return { icon: MinusSignCircleIcon, tone: "ink3" };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The pull request a Run opened, from its steps' receipts. */
function runPullRequest(run: RoutineRun) {
  for (const step of Object.values(run.flow?.state ?? {})) if (step.receipt?.kind === "pull-request") return step.receipt;
  return null;
}

/** The line under a Run's title in the Runs list: "Run 14, done, draft PR #861", "Run 15, stopped at Implement after 3 tries". */
export function runSubtitle(routine: Pick<Routine, "runCount"> & { runs?: RoutineRun[] }, run: RoutineRun) {
  const name = runName(routine, run);
  if (!run.flow) {
    const words = { running: "running", acted: "done", quiet: "quiet", failed: "failed", "skipped-busy": "skipped", missed: "missed", ended: "ended" }[
      run.status
    ];
    return `${name}, ${words ?? run.status}`;
  }
  let text = lowerFirst(flowRunText(run));
  const state = flowRunState(run);
  if (state === "failed") {
    const tries = Object.values(run.flow.state).find((step) => step.status === "failed")?.tries?.length ?? 0;
    if (tries) text += ` after ${tries + 1} tries`;
  }
  if (state === "done") {
    const pr = runPullRequest(run);
    if (pr) text += `, ${pr.draft ? "draft " : ""}PR #${pr.number}`;
  }
  return `${name}, ${text}`;
}
