import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft02Icon,
  Cancel01Icon,
  Delete02Icon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  StopIcon,
  TestTube01Icon,
  WorkflowSquare03Icon,
} from "@hugeicons/core-free-icons";
import type { FlowStep, FlowStepKind, ModelCapabilities, ModelOption, RoutineRun, RoutineTrigger } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { canRunNow, clock, triggerChipText, triggerText } from "@milagre/shared/routines";
import {
  currentStep,
  failedStep,
  findStep,
  flattenSteps,
  flowChanges,
  flowProblems,
  moveStep,
  needsAnswer,
  newStep,
  removeStep,
  replaceStep,
  stepTitle,
} from "@milagre/shared/routine-flows";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { Segmented } from "./RoutineChips";
import { HookUrl, RoutineEditor } from "./RoutineEditor";
import { RunList } from "./RunList";
import { routineProblem } from "./RoutineRow";
import { localZone } from "./use-routine-form";
import { computerOfRoutine, refreshRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { thisComputer } from "../../lib/shortcut-hints";
import { runIssueKey, runName, triggerTitle } from "./flow-look";
import { MenuRow, Popover, usePopover } from "./FlowPopover";
import { FlowCard, FlowStepList, NextStepTiles, StepMenu } from "./FlowSteps";
import { StepInspector, TriggerInspector } from "./FlowInspector";
import { RunBar, RunInspector, RunRows, type FlowAct } from "./FlowRun";

type Tab = "steps" | "runs" | "settings";
type Mode = "edit" | "run";

/** How long an edit waits before the draft is saved. */
const SAVE_DELAY = 600;

const outlineButton =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-13 font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
const primaryButton =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-control bg-ink px-3 text-13 font-medium text-surface transition-opacity hover:opacity-90 aria-disabled:opacity-40 aria-disabled:hover:opacity-40";

/** Where each flow's page was left (tab, Edit draft or Show Run, the Run), so coming back from a Chat finds it there. */
const lastView = new Map<string, { tab: Tab; mode: Mode; runId: string | null }>();

/** The trigger as a sentence for the page's subtitle: "Starts when the agent label is added to a MIL issue in Linear". */
function triggerSentence(trigger: RoutineTrigger): string {
  if (trigger.kind === "linear") {
    const issue = trigger.team ? `a ${trigger.team} issue` : "an issue";
    switch (trigger.event) {
      case "assigned":
        return `Starts when ${issue} is assigned to you in Linear`;
      case "state":
        return `Starts when ${issue} moves to ${trigger.state || "a state"} in Linear`;
      case "comment":
        return `Starts on a new comment on ${issue} in Linear`;
      default:
        return `Starts when the ${trigger.label || "chosen"} label is added to ${issue} in Linear`;
    }
  }
  if (trigger.kind === "webhook") return "Starts when its webhook gets a POST";
  return `Starts ${triggerText(trigger)}`;
}

const cannotOpen = () => false;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The flow's draft as it is edited: a copy of the published steps (or the saved draft), saved SAVE_DELAY after each edit
 * (as no draft once it matches the published steps again). While an edit is waiting or saving, the Mac's copy doesn't
 * overwrite it.
 */
function useFlowDraft(routine: RoutineWithRuns) {
  const flow = routine.flow!;
  const fromMac = flow.draft?.steps ?? flow.steps;
  const [steps, setSteps] = useState<FlowStep[]>(fromMac);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(steps);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(0);
  const writing = useRef<Promise<unknown>>(Promise.resolve());
  const published = useRef(flow);
  published.current = flow;
  const macKey = `${flow.revision}:${flow.draft?.updatedAt ?? 0}`;
  useEffect(() => {
    if (timer.current !== null || saving.current > 0) return;
    latest.current = fromMac;
    setSteps(fromMac);
  }, [macKey]);
  const save = (next: FlowStep[]) => {
    const current = published.current;
    // Back to the published steps: no draft. A flow never published keeps its draft, which is all it has.
    const draft = current.revision > 0 && same(next, current.steps) ? null : next;
    saving.current += 1;
    const task = writing.current.catch(() => {}).then(() => bridgeForKey(routine.id).updateRoutine(routine.id, { flowDraft: draft }));
    writing.current = task;
    return task
      .then(
        () => {
          setError(null);
        },
        (failure) => {
          setError(`Couldn't save the draft: ${ipcErrorMessage(failure)}`);
          throw failure;
        },
      )
      .finally(() => {
        saving.current -= 1;
        refreshRoutines(computerOfRoutine(routine));
      });
  };
  const stop = () => {
    if (timer.current === null) return false;
    clearTimeout(timer.current);
    timer.current = null;
    return true;
  };
  // Leaving the page saves an edit still waiting.
  useEffect(
    () => () => {
      if (stop()) void save(latest.current).catch(() => {});
    },
    [],
  );
  return {
    steps,
    error,
    setError,
    change(next: FlowStep[]) {
      latest.current = next;
      setSteps(next);
      stop();
      timer.current = setTimeout(() => {
        timer.current = null;
        void save(latest.current).catch(() => {});
      }, SAVE_DELAY);
    },
    /** Saves an edit still waiting, now. */
    async flush() {
      if (stop()) await save(latest.current);
      await writing.current;
    },
    /** Drops the waiting edit (Publish sends the steps itself; Discard drops them). */
    cancel: stop,
    settled: () => writing.current.catch(() => {}),
    reset(next: FlowStep[]) {
      stop();
      latest.current = next;
      setSteps(next);
    },
    latest,
  };
}

/** The step a Run's view opens on: the one waiting for an answer, else the one it stopped at, else the one under way. */
function defaultRunStep(run: RoutineRun | undefined): string {
  const flow = run?.flow;
  if (!flow) return "trigger";
  const current = currentStep(flow);
  if (needsAnswer(run) && current) return current.id;
  const failed = failedStep(flow);
  if (failed) return failed.id;
  if (current) return current.id;
  const done = flattenSteps(flow.steps).filter((entry) => flow.state[entry.step.id]?.status === "done");
  return done.at(-1)?.step.id ?? "trigger";
}

/** The Runs tab's label: its count, and how many wait for you. */
function RunsTabLabel({ count, waiting }: { count: number; waiting: number }) {
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

/** "Draft, 3 changes": what the draft changes, with Discard draft behind a confirm. */
function DraftChip({ changes, onDiscard }: { changes: string[]; onDiscard: () => void }) {
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

/** Publish revision N+1: what changes, what Runs in progress keep, then Publish. */
function PublishButton({
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

/** End Run, behind a confirm. */
function EndRunButton({ name, onEnd }: { name: string; onEnd: () => void }) {
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

/**
 * A flow Routine's page: its name with the Flow chip, the draft's changes and the revision it runs; Test run and Publish
 * while editing, Pause, Resume and End while showing a Run. Under it, Steps (Edit draft: the list editor and the selected
 * step's inspector; Show Run: a Run's steps as it ran them and the selected step's approval, receipt or failure), Runs and
 * Settings (the Routine form in place). With `narrow`, a Run Chat is open beside it and the inspector goes under the list.
 */
export function FlowPage({
  routine,
  models,
  capabilities,
  unreadChats,
  canOpen = cannotOpen,
  selectedChat = null,
  narrow = false,
  createdHookUrl,
  onDismissHook,
  onBack,
  onOpenChat,
}: {
  routine: RoutineWithRuns;
  models: ModelOption[];
  capabilities: ModelCapabilities | null;
  unreadChats: ReadonlySet<string>;
  canOpen?: (chatKey: string) => boolean;
  selectedChat?: string | null;
  narrow?: boolean;
  createdHookUrl?: string;
  onDismissHook?: () => void;
  onBack: () => void;
  onOpenChat: (chatKey: string) => void;
}) {
  const flow = routine.flow!;
  const draft = useFlowDraft(routine);
  const { steps } = draft;
  const flowRuns = useMemo(() => routine.runs.filter((run) => run.flow), [routine.runs]);
  const waitingRuns = flowRuns.filter((run) => needsAnswer(run));
  const remembered = lastView.get(routine.id);
  const [tab, setTab] = useState<Tab>(remembered?.tab ?? "steps");
  const [mode, setMode] = useState<Mode>(remembered?.mode ?? "edit");
  const [runId, setRunId] = useState<string | null>(remembered?.runId ?? waitingRuns[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(() => steps[0]?.id ?? (steps.length ? null : "trigger"));
  const [runStep, setRunStep] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settingsKey, setSettingsKey] = useState(0);
  const [starting, setStarting] = useState(false);
  // After Settings saves, its form starts again from the Routine once the Mac's new copy arrives.
  const [resetOn, setResetOn] = useState<number | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const { thisMac, computers } = useComputers();

  useEffect(() => {
    lastView.set(routine.id, { tab, mode, runId });
  }, [routine.id, tab, mode, runId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (resetOn === null || routine.updatedAt === resetOn) return;
    setResetOn(null);
    setSettingsKey((key) => key + 1);
  }, [routine.updatedAt, resetOn]);

  const run = flowRuns.find((entry) => entry.id === runId) ?? waitingRuns[0] ?? flowRuns[0];
  const computerId = computerOfRoutine(routine);
  const computerName = computerId === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === computerId)?.name ?? "another computer");
  const problems = flowProblems(steps, routine.trigger.kind);
  const byStep = new Map<string, string>();
  for (const problem of problems) if (problem.stepId && !byStep.has(problem.stepId)) byStep.set(problem.stepId, problem.message);
  const changes = flowChanges(flow.steps, steps);
  const hasDraft = flow.revision === 0 || changes.length > 0 || Boolean(flow.draft);
  const modelName = (_provider: unknown, id: string) => models.find((model) => model.id === id)?.name ?? id;
  const inProgress = flowRuns.filter((entry) => !entry.flow!.dryRun && ["running", "waiting", "paused"].includes(entry.flow!.status));
  const testIssue = runIssueKey(routine.runs.find((entry) => entry.event && !entry.flow?.dryRun && !entry.rejected));
  const problem = routineProblem(routine);

  const refresh = () => refreshRoutines(computerId);
  const bridge = () => bridgeForKey(routine.id);
  const fail = (failure: unknown) => setError(ipcErrorMessage(failure));
  const showRun = (id: string) => {
    setTab("steps");
    setMode("run");
    setRunId(id);
  };
  const act: FlowAct = (action, options) => {
    if (!run) return Promise.resolve();
    setError(null);
    return bridge()
      .flowRunAct(routine.id, run.id, action, options)
      .then(() => undefined, fail)
      .finally(refresh);
  };
  const publish = async () => {
    setError(null);
    try {
      await draft.flush();
      await bridge().updateRoutine(routine.id, { flowDraft: draft.latest.current, publishFlow: true });
      refresh();
      return true;
    } catch (failure) {
      fail(failure);
      refresh();
      return false;
    }
  };
  const discard = async () => {
    setError(null);
    draft.cancel();
    try {
      await draft.settled();
      await bridge().updateRoutine(routine.id, { flowDraft: null });
      draft.reset(flow.steps);
      refresh();
    } catch (failure) {
      fail(failure);
      refresh();
    }
  };
  const testRun = async () => {
    setError(null);
    try {
      await draft.flush();
      const { run: started } = await bridge().testFlow(routine.id);
      refresh();
      showRun(started.id);
    } catch (failure) {
      fail(failure);
    }
  };
  const runNow = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const started = await bridge().runRoutineNow(routine.id);
      refresh();
      if (started) showRun(started.id);
    } catch (failure) {
      fail(failure);
    } finally {
      setStarting(false);
    }
  };
  const toggle = () => {
    setError(null);
    bridge()
      .updateRoutine(routine.id, { enabled: !routine.enabled })
      .then(refresh, (failure) => {
        fail(failure);
        refresh();
      });
  };
  const edit = (next: FlowStep[], select?: string | null) => {
    draft.change(next);
    if (select !== undefined) setSelected(select ?? next[0]?.id ?? "trigger");
  };
  const addFirst = (kind: FlowStepKind) => {
    const step = newStep(kind, steps);
    edit([...steps, step], step.id);
  };

  const selectedStep = selected && selected !== "trigger" ? findStep(steps, selected) : null;
  const selectedEntry = selectedStep ? flattenSteps(steps).find((entry) => entry.step.id === selectedStep.id) : undefined;
  const siblings = selectedEntry
    ? selectedEntry.parentId === null
      ? steps.length
      : (() => {
          const parent = findStep(steps, selectedEntry.parentId);
          return parent?.kind === "if" ? parent[selectedEntry.branch ?? "yes"].length : 0;
        })()
    : 0;
  const publishedStep = selectedStep ? findStep(flow.steps, selectedStep.id) : null;
  const stepStatus = !selectedStep
    ? null
    : !publishedStep
      ? flow.revision > 0
        ? "new in this draft"
        : null
      : same(publishedStep, selectedStep)
        ? null
        : "edited in this draft";
  const shownRunStep = run ? (runStep[run.id] ?? defaultRunStep(run)) : null;
  const banner = waitingRuns.find((entry) => !(tab === "steps" && mode === "run" && run?.id === entry.id));
  const triggerLabel = triggerChipText(routine.trigger, localZone());
  const twoColumns = !narrow;

  const triggerCard = (
    <FlowCard
      kind="trigger"
      title={triggerTitle(routine.trigger)}
      subtitle={`Trigger, ${triggerLabel}`}
      selected={selected === "trigger"}
      onSelect={() => setSelected("trigger")}
      data-flow-step="trigger"
    />
  );

  const editView = (
    <div className={twoColumns ? "grid grid-cols-[minmax(0,1fr)_minmax(320px,384px)] items-start gap-6" : "space-y-6"}>
      <div>
        {steps.length === 0 ? (
          <>
            {triggerCard}
            <div className="relative h-6">
              <span aria-hidden className="absolute top-0 bottom-0 left-[27px] w-px bg-line-strong" />
            </div>
            <NextStepTiles onAdd={addFirst} />
          </>
        ) : (
          <FlowStepList
            steps={steps}
            selectedId={selected}
            problems={byStep}
            trigger={triggerCard}
            modelName={modelName}
            onSelect={setSelected}
            onChange={edit}
          />
        )}
      </div>
      <div className={twoColumns ? "sticky top-4" : ""}>
        {selectedStep ? (
          <StepInspector
            key={selectedStep.id}
            step={selectedStep}
            steps={steps}
            trigger={routine.trigger}
            status={stepStatus}
            problems={problems.filter((entry) => entry.stepId === selectedStep.id).map((entry) => entry.message)}
            models={models}
            capabilities={capabilities}
            testIssue={testIssue}
            onChange={(next) => edit(replaceStep(steps, selectedStep.id, next))}
            menu={
              <StepMenu
                inline
                name={selectedStep.name}
                canUp={(selectedEntry?.index ?? 0) > 0}
                canDown={(selectedEntry?.index ?? 0) < siblings - 1}
                onMove={(by) => edit(moveStep(steps, selectedStep.id, by))}
                onDelete={() => edit(removeStep(steps, selectedStep.id), null)}
              />
            }
          />
        ) : selected === "trigger" ? (
          <TriggerInspector trigger={routine.trigger} text={triggerLabel} onSettings={() => setTab("settings")} />
        ) : null}
      </div>
    </div>
  );

  const runView = run ? (
    <div className="space-y-4">
      <RunBar routine={routine} runs={flowRuns} run={run} draft={hasDraft && flow.revision > 0} onPick={setRunId} />
      <div className={twoColumns ? "grid grid-cols-[minmax(0,1fr)_minmax(320px,384px)] items-start gap-6" : "space-y-6"}>
        <RunRows
          routine={routine}
          run={run}
          selected={shownRunStep}
          now={now}
          canOpen={canOpen}
          onSelect={(id) => setRunStep((current) => ({ ...current, [run.id]: id }))}
          onOpenChat={onOpenChat}
        />
        <div className={twoColumns ? "sticky top-4" : ""}>
          <RunInspector
            key={`${run.id}:${shownRunStep}`}
            routine={routine}
            run={run}
            stepId={shownRunStep}
            canOpen={canOpen}
            onOpenChat={onOpenChat}
            act={act}
          />
        </div>
      </div>
    </div>
  ) : (
    <p data-flow-no-runs className="text-13 text-ink-2">
      No Runs yet. {flow.revision === 0 ? "Publish the flow and turn it on, or try a Test run." : "Try a Test run to see how the draft runs."}
    </p>
  );

  const runActions = run && tab === "steps" && mode === "run" && run.flow && (
    <>
      {(run.flow.status === "running" || run.flow.status === "waiting") && (
        <button type="button" data-flow-pause className={outlineButton} onClick={() => void act("pause")}>
          <HugeiconsIcon icon={PauseIcon} size={14} strokeWidth={1.8} color="currentColor" />
          Pause Run
        </button>
      )}
      {run.flow.status === "paused" && (
        <button type="button" data-flow-resume className={outlineButton} onClick={() => void act("resume")}>
          <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.8} color="currentColor" />
          Resume
        </button>
      )}
      {["running", "waiting", "paused", "failed"].includes(run.flow.status) && <EndRunButton name={runName(routine, run)} onEnd={() => void act("end")} />}
    </>
  );

  return (
    <ScrollArea className="flex h-full flex-col">
      <div
        data-routine-page={routine.id}
        data-flow-page
        className={`flex w-full flex-1 flex-col pb-10 ${narrow ? "px-3 pt-4" : "mx-auto max-w-[1040px] px-6 pt-14"}`}
      >
        <div>
          <button
            ref={back}
            type="button"
            data-routine-back
            onClick={onBack}
            className="-ml-2 inline-flex h-7 items-center gap-1.5 rounded-control pr-2 pl-1.5 text-12 font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} size={14} strokeWidth={1.8} color="currentColor" />
            Routines
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className={`truncate text-22 font-semibold tracking-[-0.02em] ${routine.enabled ? "text-ink" : "text-ink-2"}`}>{routine.name}</h1>
            <span data-flow-chip className="inline-flex h-6 shrink-0 items-center gap-1 rounded-chip bg-accent-tint px-2 text-12 font-medium text-accent-ink">
              <HugeiconsIcon icon={WorkflowSquare03Icon} size={12} strokeWidth={1.6} color="currentColor" />
              Flow
            </span>
            {tab === "steps" && mode === "edit" && flow.revision > 0 && changes.length > 0 && <DraftChip changes={changes} onDiscard={discard} />}
          </div>
          <div data-flow-toolbar className="flex shrink-0 items-center gap-2">
            {canRunNow(routine) && flow.revision > 0 && (
              <button type="button" data-flow-run-now disabled={!routine.enabled || starting} className={outlineButton} onClick={() => void runNow()}>
                <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.8} color="currentColor" />
                {starting ? "Starting" : "Run now"}
              </button>
            )}
            <Tooltip
              label={flow.revision === 0 ? "Publish the flow before turning it on" : routine.enabled ? "Turn the flow off" : "Turn the flow on"}
              side="bottom"
              align="end"
            >
              <button
                type="button"
                data-flow-revision={routine.enabled ? "on" : "off"}
                aria-pressed={routine.enabled}
                aria-disabled={flow.revision === 0}
                onClick={() => flow.revision > 0 && toggle()}
                className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-12 font-medium transition-colors ${
                  routine.enabled ? "bg-green-tint text-green-ink hover:bg-green-tint" : "bg-field text-ink-2 hover:bg-hover-2"
                }`}
              >
                <span aria-hidden className={`size-1.5 rounded-full ${routine.enabled ? "bg-green" : "bg-ink-4"}`} />
                {flow.revision === 0 ? "Off, not published" : `${routine.enabled ? "On" : "Off"}, revision ${flow.revision}`}
              </button>
            </Tooltip>
            {tab === "steps" && mode === "edit" && (
              <>
                {steps.length === 0 || problems.length > 0 ? (
                  <Tooltip label={steps.length === 0 ? "Add at least one step to test or publish" : problems[0]!.message} side="bottom" align="end" wrap>
                    <button type="button" data-flow-test aria-disabled className={`${outlineButton} opacity-40`}>
                      <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={1.8} color="currentColor" />
                      Test run
                    </button>
                  </Tooltip>
                ) : (
                  <button type="button" data-flow-test className={outlineButton} onClick={() => void testRun()}>
                    <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={1.8} color="currentColor" />
                    Test run
                  </button>
                )}
                <PublishButton
                  revision={flow.revision}
                  changes={changes}
                  problem={steps.length === 0 ? "Add at least one step to test or publish" : (problems[0]?.message ?? null)}
                  inProgress={inProgress.map((entry) => runName(routine, entry))}
                  waiting={inProgress.some((entry) => needsAnswer(entry))}
                  onPublish={publish}
                />
              </>
            )}
            {runActions}
          </div>
        </div>
        <p data-flow-subtitle className="mt-2 text-12 text-ink-3">
          {triggerSentence(routine.trigger)}. Runs on {computerName}.
          {flow.revision > 0 ? ` Runs in progress keep revision ${flow.revision}.` : " Publish it to turn it on."}
        </p>
        <div className="mt-4 flex items-end gap-4 border-b border-line">
          <div role="tablist" aria-label="Flow" className="flex flex-1 gap-6">
            {(
              [
                ["steps", "Steps"],
                ["runs", <RunsTabLabel key="runs" count={routine.runs.length} waiting={waitingRuns.length} />],
                ["settings", "Settings"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                data-flow-tab={id}
                onClick={() => setTab(id)}
                className={`relative flex h-9 items-center text-13 font-medium transition-colors ${tab === id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {label}
                {tab === id && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-ink" />}
              </button>
            ))}
          </div>
          {tab === "steps" && (
            <Segmented<Mode>
              label="Steps"
              value={mode}
              className="mb-2 shrink-0"
              options={[
                { value: "edit", label: "Edit draft", icon: PencilEdit02Icon },
                { value: "run", label: "Show Run", icon: WorkflowSquare03Icon, disabled: flowRuns.length === 0 },
              ]}
              onChange={setMode}
            />
          )}
        </div>

        {problem && (
          <p data-routine-problem className="mt-4 flex items-start gap-2 rounded-card bg-red-tint px-4 py-3 text-13 text-red-ink">
            <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.8} color="currentColor" className="mt-px shrink-0" />
            {problem}
          </p>
        )}
        {(error || draft.error) && (
          <p role="alert" data-flow-error className="mt-4 text-13 break-words text-red-ink">
            {error ?? draft.error}
          </p>
        )}
        {createdHookUrl && (
          <div data-routine-created className="mt-4 space-y-2 rounded-card border border-line px-4 py-3">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-12 text-ink-2">
                Flow created. Send POST requests to this URL. While {thisComputer} is away, the relay holds them for up to 24 hours.
              </p>
              <button
                type="button"
                aria-label="Dismiss"
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover hover:text-ink"
                onClick={onDismissHook}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} color="currentColor" />
              </button>
            </div>
            <HookUrl url={createdHookUrl} editing={false} />
          </div>
        )}
        {banner && (
          <div data-flow-waiting-banner={banner.id} className="mt-4 flex items-center gap-3 rounded-card bg-orange-tint px-4 py-3">
            <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.8} color="currentColor" className="shrink-0 text-orange-ink" />
            <span className="min-w-0 flex-1 text-13 text-ink">
              {runName(routine, banner)}
              {runIssueKey(banner) ? ` (${runIssueKey(banner)})` : ""} is waiting for you at{" "}
              {stepTitle(currentStep(banner.flow) ?? ({ name: "a step" } as FlowStep))}
            </span>
            <button
              type="button"
              data-flow-show-waiting
              onClick={() => showRun(banner.id)}
              className="shrink-0 text-13 font-semibold text-orange-ink hover:underline"
            >
              Show {runName(routine, banner)}
            </button>
          </div>
        )}

        <div className="mt-5">
          {tab === "steps" && (mode === "edit" ? editView : runView)}
          {tab === "runs" &&
            (routine.runs.length > 0 ? (
              <RunList
                runs={routine.runs}
                routineName={routine.name}
                now={now}
                unreadChats={unreadChats}
                canOpen={canOpen}
                selectedChat={selectedChat}
                onOpenChat={onOpenChat}
                onOpenFlowRun={showRun}
              />
            ) : (
              <p data-routine-runs-empty className="text-13 text-ink-2">
                No Runs yet{routine.enabled && typeof routine.nextRunAt === "number" ? `. Next Run ${clock(routine.nextRunAt)}` : ""}
              </p>
            ))}
          {tab === "settings" && (
            <RoutineEditor
              key={settingsKey}
              embedded
              initial={routine}
              models={models}
              capabilities={capabilities}
              onCancel={() => setSettingsKey((key) => key + 1)}
              onSaved={() => {
                setResetOn(routine.updatedAt);
                refresh();
              }}
              onCreated={() => {}}
              onDeleted={() => {
                refresh();
                onBack();
              }}
            />
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
