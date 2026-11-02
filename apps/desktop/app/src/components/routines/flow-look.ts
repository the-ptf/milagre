import {
  BotIcon,
  CheckmarkSquare02Icon,
  GitPullRequestIcon,
  HashtagIcon,
  HourglassIcon,
  LeftToRightListBulletIcon,
  Link01Icon,
  Message01Icon,
  SecurityCheckIcon,
  SplitIcon,
  TextFontIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import type { FlowField, FlowRun, FlowStepKind, Routine, RoutineRun, RoutineTrigger } from "@milagre/shared/model";
import { clock } from "@milagre/shared/routines";

export type HugeIconData = typeof BotIcon;

/** A step type's icon and its tile's fill and ink, in the editor and the Run view. */
export const STEP_LOOK: Record<FlowStepKind | "trigger", { icon: HugeIconData; tile: string }> = {
  trigger: { icon: ZapIcon, tile: "bg-purple-tint text-purple-ink" },
  agent: { icon: BotIcon, tile: "bg-accent-tint text-accent-ink" },
  if: { icon: SplitIcon, tile: "bg-field text-ink-2" },
  ask: { icon: SecurityCheckIcon, tile: "bg-orange-tint text-orange-ink" },
  wait: { icon: HourglassIcon, tile: "bg-purple-tint text-purple-ink" },
  "pull-request": { icon: GitPullRequestIcon, tile: "bg-green-tint text-green-ink" },
  "linear-comment": { icon: Message01Icon, tile: "bg-green-tint text-green-ink" },
};

/** An output field's glyph on its chip and in the Output table. */
export const FIELD_ICON: Record<FlowField["type"], HugeIconData> = {
  text: TextFontIcon,
  choice: LeftToRightListBulletIcon,
  "yes-no": CheckmarkSquare02Icon,
  number: HashtagIcon,
  link: Link01Icon,
};

export const FIELD_TYPE_WORDS: Record<FlowField["type"], string> = {
  text: "text",
  choice: "choice",
  "yes-no": "yes or no",
  number: "number",
  link: "link",
};

/** What starts the flow, as its trigger card's title: "Linear label added", "Schedule", "Webhook". */
export function triggerTitle(trigger: RoutineTrigger): string {
  if (trigger.kind === "schedule") return "Schedule";
  if (trigger.kind === "webhook") return "Webhook";
  if (trigger.kind !== "linear") return "Trigger";
  switch (trigger.event) {
    case "assigned":
      return "Linear issue assigned";
    case "state":
      return "Linear issue moved";
    case "comment":
      return "Linear comment";
    default:
      return "Linear label added";
  }
}

/** The Linear issue a Run is for, as its key, or null. */
export function runIssueKey(run: RoutineRun | undefined): string | null {
  return run?.event?.kind === "linear" ? run.event.issue.key : null;
}

/** A Run's issue in a few words for the run bar: "MIL-482 Retry webhook deliveries", else its title, else when it started. */
export function runHeadline(run: RoutineRun): string {
  if (run.event?.kind === "linear") return `${run.event.issue.key} ${run.event.issue.title}`.trim();
  if (run.title?.trim()) return run.title.trim();
  return run.flow?.dryRun ? "Test run" : `Started ${clock(run.startedAt)}`;
}

/** What the trigger did for a Run, under the trigger's row: "label added on MIL-482 at 10:02", "at 10:02". */
export function triggerRunText(routine: Routine, run: RoutineRun): string {
  const at = clock(run.startedAt);
  if (run.event?.kind === "linear") {
    const { change, issue } = run.event;
    const what =
      change === "label-added"
        ? routine.trigger.kind === "linear" && routine.trigger.label
          ? `${routine.trigger.label} added to`
          : "label added to"
        : change === "assigned"
          ? "assigned"
          : change === "state"
            ? `moved to ${issue.state} on`
            : `comment by ${run.event.comment?.author ?? "someone"} on`;
    return change === "assigned" ? `${issue.key} assigned at ${at}` : `${what} ${issue.key} at ${at}`;
  }
  if (run.event?.kind === "webhook") return `Delivery at ${at}`;
  return run.flow?.dryRun ? `Test run at ${at}` : `Started at ${at}`;
}

/**
 * The number a Run goes by on the page ("Run 14"), or 0 for a Test run, which never counts. Runs are kept newest first and
 * the oldest trimmed, so the count starts from the Routine's total.
 */
function runNumber(routine: Routine & { runs: RoutineRun[] }, run: RoutineRun): number {
  if (run.flow?.dryRun) return 0;
  const counted = routine.runs.filter((entry) => !entry.flow?.dryRun);
  const index = counted.findIndex((entry) => entry.id === run.id);
  if (index < 0) return 0;
  return Math.max(0, routine.runCount - counted.length) + (counted.length - index);
}

/** A Run's name on the page: "Run 14", or "Test run". */
export const runName = (routine: Routine & { runs: RoutineRun[] }, run: RoutineRun) => {
  const number = runNumber(routine, run);
  return number > 0 ? `Run ${number}` : "Test run";
};

/** A flow Run's state as its chip says it: the words and the chip's fill and ink. */
export function flowStatusLook(flow: FlowRun, waitingForYou: boolean): { text: string; tone: string } {
  switch (flow.status) {
    case "running":
      return { text: "Running", tone: "bg-accent-tint text-accent-ink" };
    case "waiting":
      return waitingForYou ? { text: "Waiting for you", tone: "bg-orange-tint text-orange-ink" } : { text: "Waiting", tone: "bg-field text-ink-2" };
    case "paused":
      return { text: "Paused", tone: "bg-field text-ink-2" };
    case "failed":
      return { text: "Stopped", tone: "bg-red-tint text-red-ink" };
    case "ended":
      return { text: "Ended", tone: "bg-field text-ink-2" };
    default:
      return { text: flow.dryRun ? "Test run done" : "Done", tone: "bg-green-tint text-green-ink" };
  }
}

/** "4 min", "41 s": how long something took. */
export function tookText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/** The first line of an error, as a row shows it. */
export const firstLine = (text: string | undefined) =>
  text
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";
