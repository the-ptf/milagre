import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowLeft02Icon, Cancel01Icon, PauseIcon, PlayIcon, TestTube01Icon, WorkflowSquare03Icon } from "@hugeicons/core-free-icons";
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
  insertStep,
  moveStep,
  needsAnswer,
  newStep,
  removeStep,
  replaceStep,
  stepSubtitle,
  stepTitle,
} from "@milagre/shared/routine-flows";
import type { FlowPlace } from "@milagre/shared/routine-flow-graph";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { HookUrl, RoutineEditor } from "./RoutineEditor";
import { RunList } from "./RunList";
import { routineProblem } from "./RoutineRow";
import { localZone } from "./use-routine-form";
import { computerOfRoutine, refreshRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeForKey } from "../../lib/computer-bridge";
import { useComputers } from "../../lib/computers";
import { thisComputer } from "../../lib/shortcut-hints";
import { runIssueKey, runName } from "./flow-look";
import { StepMenu } from "./FlowSteps";
import { FlowCanvas } from "./FlowCanvas";
import { StepInspector, TriggerInspector } from "./FlowInspector";
import { RunBar, RunInspector, type FlowAct } from "./FlowRun";
import { DraftChip, EndRunButton, PublishButton, RunsTabLabel, outlineButton, runMarker, triggerCard } from "./FlowPageParts";

type Tab = "steps" | "runs" | "settings";

const SAVE_DELAY = 600;

const lastView = new Map<string, { tab: Tab; runOpen: boolean; runId: string | null }>();

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
    async flush() {
      if (stop()) await save(latest.current);
      await writing.current;
    },
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
  const [runOpen, setRunOpen] = useState(remembered?.runOpen ?? false);
  const [runId, setRunId] = useState<string | null>(remembered?.runId ?? waitingRuns[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(() => steps[0]?.id ?? (steps.length ? null : "trigger"));
  const [runStep, setRunStep] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settingsKey, setSettingsKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [resetOn, setResetOn] = useState<number | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const { thisMac, computers } = useComputers();

  useEffect(() => {
    lastView.set(routine.id, { tab, runOpen, runId });
  }, [routine.id, tab, runOpen, runId]);
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
    setTab("runs");
    setRunOpen(true);
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
  const addAt = (kind: FlowStepKind, where: FlowPlace) => {
    const step = newStep(kind, steps);
    edit(insertStep(steps, where, step), step.id);
  };
  const pathLength = (where: FlowPlace) => {
    if (where.parentId === null) return steps.length;
    const parent = findStep(steps, where.parentId);
    return parent?.kind === "if" ? parent[where.branch ?? "yes"].length : 0;
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
  const viewingRun = tab === "runs" && runOpen && Boolean(run);
  const banner = waitingRuns.find((entry) => !(viewingRun && run?.id === entry.id));
  const triggerLabel = triggerChipText(routine.trigger, localZone());
  const twoColumns = !narrow;

  const canvasBox = twoColumns ? "flex h-[calc(100vh-280px)] min-h-[480px] gap-4" : "space-y-4";
  const canvasPane = twoColumns ? "min-w-0 flex-1" : "h-[440px]";
  const sidePane = twoColumns ? "w-[340px] shrink-0" : "";
  const triggerView = triggerCard(routine.trigger, triggerLabel, steps);

  const editView = (
    <div className={canvasBox}>
      <div className={canvasPane}>
        <FlowCanvas
          mode="edit"
          steps={steps}
          viewKey={`edit:${routine.id}`}
          selected={selected}
          select={setSelected}
          problems={byStep}
          subtitle={(step) => stepSubtitle(step, { modelName })}
          trigger={triggerView}
          add={addAt}
          move={(id, by) => edit(moveStep(steps, id, by))}
          remove={(id) => edit(removeStep(steps, id), null)}
          siblings={pathLength}
        />
      </div>
      <ScrollArea className={sidePane}>
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
      </ScrollArea>
    </div>
  );

  const markOf = runMarker(routine, run, now);
  const runView = run ? (
    <div className="space-y-3">
      <RunBar routine={routine} runs={flowRuns} run={run} draft={hasDraft && flow.revision > 0} onPick={setRunId} onBack={() => setRunOpen(false)} />
      <div className={canvasBox}>
        <div className={canvasPane}>
          <FlowCanvas
            mode="run"
            steps={run.flow!.steps}
            runState={run.flow!.state}
            viewKey={`run:${run.id}`}
            focus={shownRunStep}
            selected={shownRunStep}
            select={(id) => setRunStep((current) => ({ ...current, [run.id]: id }))}
            problems={new Map()}
            subtitle={(step) => stepSubtitle(step, { modelName })}
            trigger={triggerView}
            mark={markOf}
          />
        </div>
        <ScrollArea className={sidePane}>
          <RunInspector
            key={`${run.id}:${shownRunStep}`}
            routine={routine}
            run={run}
            stepId={shownRunStep}
            canOpen={canOpen}
            onOpenChat={onOpenChat}
            act={act}
          />
        </ScrollArea>
      </div>
    </div>
  ) : null;

  const runActions = run && viewingRun && run.flow && (
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
        className={`flex w-full flex-1 flex-col pb-10 ${narrow ? "px-3 pt-4" : `mx-auto px-6 pt-14 ${tab === "settings" || (tab === "runs" && !viewingRun) ? "max-w-[1040px]" : "max-w-[1440px]"}`}`}
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
            {tab === "steps" && flow.revision > 0 && changes.length > 0 && <DraftChip changes={changes} onDiscard={discard} />}
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
            {tab === "steps" && (
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
                onClick={() => {
                  if (id === "runs" && tab === "runs") setRunOpen(false);
                  setTab(id);
                }}
                className={`relative flex h-9 items-center text-13 font-medium transition-colors ${tab === id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {label}
                {tab === id && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-ink" />}
              </button>
            ))}
          </div>
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
          {tab === "steps" && editView}
          {tab === "runs" &&
            (viewingRun ? (
              runView
            ) : routine.runs.length > 0 ? (
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
