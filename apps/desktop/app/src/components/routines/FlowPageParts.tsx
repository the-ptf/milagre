import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon, Delete02Icon, PencilEdit02Icon, StopIcon } from "@hugeicons/core-free-icons";
import type { FlowStep, RoutineRun, RoutineTrigger } from "@milagre/shared/model";
import { flattenSteps, runRows, stepReads, triggerFields } from "@milagre/shared/routine-flows";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import type { RoutineWithRuns } from "../../lib/routines";
import { triggerRunText, triggerTitle } from "./flow-look";
import { MenuRow, Popover, usePopover } from "./FlowPopover";
import { rowText } from "./FlowRun";
import type { RunMark } from "./FlowCanvasNodes";

export const outlineButton =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-13 font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
export const primaryButton =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-control bg-ink px-3 text-13 font-medium text-surface transition-opacity hover:opacity-90 aria-disabled:opacity-40 aria-disabled:hover:opacity-40";

/** The trigger's card on the canvas, with only the trigger fields a step reads. */
export function triggerCard(trigger: RoutineTrigger, label: string, steps: FlowStep[]) {
  const reads = new Set(flattenSteps(steps).flatMap((entry) => stepReads(entry.step)));
  return { title: triggerTitle(trigger), subtitle: `Trigger, ${label}`, fields: triggerFields(trigger.kind).filter((field) => reads.has(field.ref)) };
}

/** What the Run canvas shows on each node: its state and the words under its title. */
export function runMarker(routine: RoutineWithRuns, run: RoutineRun | undefined, now: number) {
  const rows = run?.flow ? new Map(runRows(run.flow).flatMap((row) => (row.kind === "step" ? [[row.step.id, row] as const] : []))) : null;
  return (id: string): RunMark | undefined => {
    if (!run) return undefined;
    if (id === "trigger") return { status: "done", state: null, text: triggerRunText(routine, run), tone: "text-ink-3" };
    const row = rows?.get(id);
    if (!row) return undefined;
    const words = rowText(row.step, row.status, row.run, now);
    return { status: row.status, state: row.run, text: words.text, tone: words.tone };
  };
}

export function RunsTabLabel({ count, waiting }: { count: number; waiting: number }) {
  return (
    <>
      Runs <span className="text-ink-3 tabular-nums">{count}</span>
      {waiting > 0 && (
        <span data-flow-waiting-badge className="ml-1 inline-flex h-5 items-center rounded-full bg-orange-tint px-2 text-11 font-medium text-orange-ink">
          {waiting} waiting
        </span>
      )}
    </>
  );
}

export function DraftChip({ changes, onDiscard }: { changes: string[]; onDiscard: () => void }) {
  const popover = usePopover(320);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!popover.open) setConfirming(false);
  }, [popover.open]);
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-draft-chip
        onClick={popover.toggle}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-chip bg-field px-2 text-12 font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
      >
        Draft, {changes.length === 1 ? "1 change" : `${changes.length} changes`}
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.6} color="currentColor" />
      </button>
      <Popover state={popover} label="Draft" width={320} role="menu" className="p-1.5" data-flow-draft-menu>
        <ScrollArea className="max-h-48 px-2 pt-1 pb-2">
          {changes.map((line) => (
            <p key={line} className="truncate py-0.5 text-12 text-ink-2">
              {line}
            </p>
          ))}
        </ScrollArea>
        {confirming ? (
          <div className="flex items-center gap-2 border-t border-line px-2 pt-2">
            <span className="min-w-0 flex-1 text-12 text-ink">Discard the draft and its changes?</span>
            <button type="button" className={`${outlineButton} h-7 px-2 text-12`} onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              type="button"
              data-flow-discard-confirm
              className={`${outlineButton} h-7 border-red/30 px-2 text-12 text-red-ink`}
              onClick={() => {
                popover.close();
                onDiscard();
              }}
            >
              Discard
            </button>
          </div>
        ) : (
          <MenuRow icon={Delete02Icon} label="Discard draft" danger onSelect={() => setConfirming(true)} data-flow-discard />
        )}
      </Popover>
    </>
  );
}

export function PublishButton({
  revision,
  changes,
  problem,
  inProgress,
  waiting,
  onPublish,
}: {
  revision: number;
  changes: string[];
  problem: string | null;
  inProgress: string[];
  waiting: boolean;
  onPublish: () => Promise<boolean>;
}) {
  const popover = usePopover(380, "end");
  const [busy, setBusy] = useState(false);
  const next = revision + 1;
  const blocked = problem ?? (revision > 0 && changes.length === 0 ? "No changes to publish" : null);
  const note =
    revision === 0
      ? `New Runs use revision 1 once you turn the flow on.`
      : inProgress.length > 0
        ? `${inProgress.join(", ")} ${inProgress.length === 1 ? "keeps" : "keep"} revision ${revision}${waiting ? " and still waits for you" : ""}. New Runs use revision ${next}.`
        : `Runs in progress keep revision ${revision}. New Runs use revision ${next}.`;
  const button = (
    <button
      ref={popover.trigger}
      type="button"
      aria-disabled={blocked !== null}
      aria-haspopup="dialog"
      aria-expanded={popover.open}
      data-flow-publish
      onClick={() => blocked === null && popover.toggle()}
      className={primaryButton}
    >
      Publish revision {next}
    </button>
  );
  return (
    <>
      {blocked ? (
        <Tooltip label={blocked} side="bottom" align="end" wrap>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      <Popover state={popover} label={`Publish revision ${next}`} width={380} className="p-4" data-flow-publish-dialog>
        <h3 className="text-15 font-semibold text-ink">Publish revision {next}</h3>
        <p className="mt-1 text-12 text-ink-3">
          {revision === 0 ? "The first revision" : `${changes.length === 1 ? "1 change" : `${changes.length} changes`} since revision ${revision}`}
        </p>
        <ScrollArea className="mt-3 max-h-48 divide-y divide-line rounded-control bg-field">
          {changes.map((line) => (
            <p key={line} className="flex items-center gap-2 px-3 py-2 text-13 text-ink">
              <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{line}</span>
            </p>
          ))}
        </ScrollArea>
        <p className="mt-3 flex items-start gap-2 rounded-control bg-orange-tint px-3 py-2 text-12 text-orange-ink">
          <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.8} color="currentColor" className="mt-px shrink-0" />
          {note}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={outlineButton} onClick={() => popover.close()}>
            Cancel
          </button>
          <button
            type="button"
            data-flow-publish-confirm
            aria-disabled={busy}
            className={primaryButton}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void onPublish().then((ok) => {
                setBusy(false);
                if (ok) popover.close(false);
              });
            }}
          >
            {busy ? "Publishing…" : `Publish revision ${next}`}
          </button>
        </div>
      </Popover>
    </>
  );
}

export function EndRunButton({ name, onEnd }: { name: string; onEnd: () => void }) {
  const popover = usePopover(300, "end");
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        data-flow-end
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        className={outlineButton}
        onClick={popover.toggle}
      >
        <HugeiconsIcon icon={StopIcon} size={14} strokeWidth={1.8} color="currentColor" />
        End Run
      </button>
      <Popover state={popover} label={`End ${name}`} width={300} className="p-4" data-flow-end-dialog>
        <h3 className="text-15 font-semibold text-ink">End {name}?</h3>
        <p className="mt-1 text-12 text-ink-2">It stops where it is. What it already did stays, and its Worktree too.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={outlineButton} onClick={() => popover.close()}>
            Cancel
          </button>
          <button
            type="button"
            data-flow-end-confirm
            className={`${outlineButton} border-red/30 text-red-ink`}
            onClick={() => {
              popover.close(false);
              onEnd();
            }}
          >
            End Run
          </button>
        </div>
      </Popover>
    </>
  );
}
