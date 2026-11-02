import { useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  DashedLineCircleIcon,
  Invoice03Icon,
  LinkSquare02Icon,
  LockIcon,
  MinusSignCircleIcon,
  PauseCircleIcon,
  RefreshIcon,
  Shield01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { FlowReceipt, FlowStep, FlowStepRun, RoutineRun } from "@milagre/shared/model";
import { clock } from "@milagre/shared/routines";
import {
  failedStep,
  flattenSteps,
  flowRunText,
  needsAnswer,
  outputSummary,
  runRows,
  stepReads,
  stepTitle,
  type FlowRunRow,
} from "@milagre/shared/routine-flows";
import { Select } from "../primitives/Select";
import { SpinnerRing } from "../primitives/SpinnerRing";
import type { RoutineWithRuns } from "../../lib/routines";
import { firstLine, flowStatusLook, runHeadline, runName, tookText, triggerRunText, triggerTitle } from "./flow-look";
import { FlowCard, PathLabel } from "./FlowSteps";
import { InspectorCard } from "./FlowInspector";

const primaryButton =
  "inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-control bg-ink px-3 text-13 font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40";
const secondaryButton =
  "inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-control bg-field px-3 text-13 font-medium text-ink transition-colors hover:bg-hover-2 disabled:opacity-40";
const textarea = "w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 text-13 text-ink outline-none placeholder:text-ink-3";

export type FlowAct = (action: "approve" | "reject" | "pause" | "resume" | "end" | "retry", options?: { reason?: string; note?: string }) => Promise<void>;

/** A step's state as an icon at the end of its row. */
function StateIcon({ status }: { status: string }) {
  const icon = (glyph: typeof CheckmarkCircle02Icon, tone: string, label: string) => (
    <span role="img" aria-label={label} data-flow-state={status} className={`flex size-5 shrink-0 items-center justify-center ${tone}`}>
      <HugeiconsIcon icon={glyph} size={16} strokeWidth={1.8} color="currentColor" />
    </span>
  );
  switch (status) {
    case "done":
      return icon(CheckmarkCircle02Icon, "text-green", "Done");
    case "waiting":
      return icon(PauseCircleIcon, "text-orange", "Waiting");
    case "running":
      return (
        <span role="img" aria-label="Running" data-flow-state="running" className="flex size-5 shrink-0 items-center justify-center">
          <SpinnerRing size={14} color="var(--accent)" />
        </span>
      );
    case "failed":
      return icon(CancelCircleIcon, "text-red", "Failed");
    case "pending":
      return icon(DashedLineCircleIcon, "text-ink-4", "Not started");
    default:
      return icon(MinusSignCircleIcon, "text-ink-4", status === "skipped" ? "Skipped" : status === "not-taken" ? "Not taken" : "Did not run");
  }
}

/** What a step's row says under its name, and in which ink. */
function rowText(step: FlowStep, status: string, state: FlowStepRun | null, now: number): { text: string; tone: string } {
  const quiet = "text-ink-3";
  if (status === "not-taken") return { text: "Not taken", tone: quiet };
  if (status === "not-run") return { text: "Did not run", tone: quiet };
  if (status === "pending" || !state) return { text: "Not started", tone: quiet };
  if (status === "skipped") return { text: state.summary || "Skipped", tone: quiet };
  if (status === "running") {
    const own = step.kind === "agent" && step.chat === "own" ? " in its own Chat" : "";
    return { text: state.startedAt ? `Running for ${tookText(now - state.startedAt)}${own}` : `Running${own}`, tone: "text-accent-ink" };
  }
  if (status === "waiting") {
    if (state.approval && !state.approval.decision) return { text: `Waiting for you since ${clock(state.approval.askedAt)}`, tone: "text-orange-ink" };
    return { text: state.waitUntil ? `Waiting, up to ${clock(state.waitUntil)}` : "Waiting", tone: "text-orange-ink" };
  }
  if (status === "failed") {
    const tries = (state.tries?.length ?? 0) + 1;
    const error = firstLine(state.error) || "Failed";
    return { text: tries > 1 ? `Failed ${tries} times, ${error}` : error, tone: "text-red-ink" };
  }
  const parts = [state.summary || outputSummary(state.output)];
  if (!state.summary && state.approval?.decision === "approved" && state.approval.decidedAt) parts.push(`approved at ${clock(state.approval.decidedAt)}`);
  if (step.kind === "agent" && state.startedAt && state.endedAt) parts.push(tookText(state.endedAt - state.startedAt));
  return { text: parts.filter(Boolean).join(", ") || "Done", tone: quiet };
}

/**
 * The bar over a Run: which Run (a picker over the flow's Runs), its state, its issue, the revision it runs and when it
 * started; with a draft open, a lock says the Run shows its own steps, not the draft.
 */
export function RunBar({
  routine,
  runs,
  run,
  draft,
  onPick,
}: {
  routine: RoutineWithRuns;
  runs: RoutineRun[];
  run: RoutineRun;
  draft: boolean;
  onPick: (runId: string) => void;
}) {
  const flow = run.flow!;
  const look = flowStatusLook(flow, needsAnswer(run));
  const chip = flow.status === "failed" || flow.status === "paused" ? flowRunText(run) : look.text;
  return (
    <div data-flow-run-bar className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-inset px-3 py-1.5">
      <Select
        label="Run"
        variant="chip"
        compact
        value={run.id}
        options={runs.map((entry) => ({ value: entry.id, label: runName(routine, entry), description: `${runHeadline(entry)} · ${flowRunText(entry)}` }))}
        onChange={onPick}
        width={340}
      />
      <span data-flow-run-status={flow.status} className={`inline-flex h-6 shrink-0 items-center rounded-chip px-2 text-12 font-medium ${look.tone}`}>
        {chip}
      </span>
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-ink" title={runHeadline(run)}>
        {runHeadline(run)}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-12 text-ink-3">
        {`revision ${flow.revision}, started ${clock(run.startedAt)}${draft ? ", your draft is hidden" : ""}`}
        {draft && <HugeiconsIcon icon={LockIcon} size={14} strokeWidth={1.8} color="currentColor" aria-label="The Run keeps its own steps" />}
      </span>
    </div>
  );
}

/** A thin rail between rows; green once the row under it has been reached. */
function Rail({ left, reached }: { left: number; reached: boolean }) {
  return (
    <div className="relative h-6">
      <span aria-hidden className={`absolute top-0 bottom-0 w-px ${reached ? "bg-green" : "bg-line-strong"}`} style={{ left }} />
    </div>
  );
}

const INDENT = 44;
const RAIL = 27;

/**
 * A Run's steps as it ran them: the trigger, then each step's row with its state (done, waiting for you, running, failed,
 * not started, did not run), an If's paths under it with the one taken marked. A row selects its step; Open Chat opens
 * the Chat a step ran in.
 */
export function RunRows({
  routine,
  run,
  selected,
  now,
  canOpen,
  onSelect,
  onOpenChat,
}: {
  routine: RoutineWithRuns;
  run: RoutineRun;
  selected: string | null;
  now: number;
  canOpen: (chatKey: string) => boolean;
  onSelect: (id: string) => void;
  onOpenChat: (chatKey: string) => void;
}) {
  const rows = runRows(run.flow);
  const openChat = (chatId: string | undefined) =>
    chatId && canOpen(chatId) ? (
      <button
        type="button"
        data-flow-open-chat={chatId}
        onClick={() => onOpenChat(chatId)}
        className="inline-flex h-7 shrink-0 items-center rounded-control px-2 text-12 font-medium text-accent-ink transition-colors hover:bg-accent-tint"
      >
        Open Chat
      </button>
    ) : null;
  const rails = (depth: number) =>
    Array.from({ length: depth }, (_, index) => (
      <span key={index} aria-hidden className="absolute top-0 bottom-0 w-px bg-line-strong" style={{ left: index * INDENT + RAIL }} />
    ));
  return (
    <div data-flow-run-rows={run.id}>
      <FlowCard
        kind="trigger"
        title={triggerTitle(routine.trigger)}
        subtitle={triggerRunText(routine, run)}
        selected={selected === "trigger"}
        onSelect={() => onSelect("trigger")}
        data-flow-run-step="trigger"
        menu={<StateIcon status="done" />}
      />
      {rows.map((row: FlowRunRow, index) => {
        if (row.kind === "path") {
          const text =
            row.path === "yes"
              ? row.decided
                ? row.taken
                  ? "Yes, taken"
                  : "Yes, not taken"
                : "Yes"
              : row.decided
                ? row.taken
                  ? "Otherwise, taken"
                  : "Otherwise, not taken"
                : "Otherwise";
          return (
            <div
              key={`${row.parentId}:${row.path}`}
              className="relative"
              style={{ paddingLeft: (row.depth - 1) * INDENT }}
              data-flow-run-path={`${row.parentId}:${row.path}`}
            >
              {rails(row.depth)}
              <PathLabel text={text} tone={row.taken ? "bg-green-tint text-green-ink" : row.decided ? "bg-field text-ink-3" : "bg-field text-ink-2"} />
            </div>
          );
        }
        const { step, status, run: state, depth } = row;
        const previous = rows[index - 1];
        const reached = status !== "pending" && status !== "not-run" && status !== "not-taken";
        const words = rowText(step, status, state, now);
        const ring =
          status === "waiting" && state?.approval && !state.approval.decision ? "ring-2 ring-orange" : status === "failed" ? "ring-2 ring-red" : undefined;
        return (
          <div key={step.id} className="relative" style={{ paddingLeft: depth * INDENT }}>
            {rails(depth)}
            {previous?.kind !== "path" && <Rail left={RAIL} reached={reached} />}
            <FlowCard
              kind={step.kind}
              title={stepTitle(step)}
              subtitle={words.text}
              subtitleTone={words.tone}
              selected={selected === step.id}
              ring={ring}
              dim={!reached}
              onSelect={() => onSelect(step.id)}
              data-flow-run-step={step.id}
              data-flow-run-status={status}
              menu={
                <span className="flex items-center gap-1">
                  {openChat(state?.chatId)}
                  {state?.receipt && (
                    <span role="img" aria-label="Receipt kept" className="flex size-5 items-center justify-center text-green-ink">
                      <HugeiconsIcon icon={Invoice03Icon} size={14} strokeWidth={1.8} color="currentColor" />
                    </span>
                  )}
                  <StateIcon status={status} />
                </span>
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** Label and value rows in a bordered table: the pull request preview and the receipt. */
function Table({ rows, header }: { rows: Array<[string, ReactNode]>; header?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-control border border-line">
      {header}
      <dl className="divide-y divide-line">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3 px-3 py-2">
            <dt className="w-28 shrink-0 text-13 text-ink-2">{label}</dt>
            <dd className="min-w-0 flex-1 text-13 break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Note({ icon, tone = "bg-page text-ink-2", children }: { icon: typeof Shield01Icon; tone?: string; children: ReactNode }) {
  return (
    <p className={`flex items-start gap-2 rounded-control px-3 py-2 text-12 ${tone}`}>
      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} color="currentColor" className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** An approval waiting on the owner: what it asks (or the pull request it would open), Approve, and Reject with a reason. */
function ApprovalCard({ name, step, state, act }: { name: string; step: FlowStep; state: FlowStepRun; act: FlowAct }) {
  const approval = state.approval!;
  const preview = approval.preview;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (work: Promise<void>) => {
    setBusy(true);
    work.finally(() => setBusy(false));
  };
  return (
    <div data-flow-approval className="space-y-3">
      {preview ? (
        <>
          <p className="text-12 font-medium text-ink-2">This will open</p>
          <Table
            rows={[
              ...(preview.repository ? ([["Repository", preview.repository]] as Array<[string, ReactNode]>) : []),
              ["Branches", `${preview.branch} into ${preview.base}`],
              ["Title", preview.title],
              ...(preview.changes ? ([["Changes", preview.changes]] as Array<[string, ReactNode]>) : []),
              ["Opens as", preview.draft ? "Draft PR" : "Ready PR"],
            ]}
          />
          {step.kind === "pull-request" && (
            <Note icon={Invoice03Icon} tone="bg-green-tint text-green-ink">
              Keeps a receipt. If {name} restarts, it finds this pull request by branch instead of opening a second one.
            </Note>
          )}
        </>
      ) : (
        <p data-flow-approval-message className="rounded-control bg-field px-3 py-2 text-13 whitespace-pre-wrap text-ink">
          {approval.message || "Approve to go on."}
        </p>
      )}
      {rejecting ? (
        <div className="space-y-2">
          <textarea
            aria-label="Reason"
            data-flow-reject-reason
            rows={3}
            className={textarea}
            placeholder="Why not? The Run ends with your reason."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className={secondaryButton} onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              type="button"
              data-flow-reject
              disabled={busy}
              className={`${secondaryButton} text-red-ink`}
              onClick={() => run(act("reject", reason.trim() ? { reason: reason.trim() } : {}))}
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button type="button" data-flow-approve disabled={busy} className={primaryButton} onClick={() => run(act("approve"))}>
            {preview ? (preview.draft ? "Open draft PR" : "Open PR") : "Approve"}
          </button>
          <button type="button" data-flow-reject-start className={secondaryButton} onClick={() => setRejecting(true)}>
            Reject with reason
          </button>
        </div>
      )}
      <p className="text-12 text-ink-3">
        Rejecting ends {name}. No answer by {clock(approval.expiresAt, undefined, true)} ends it too.
      </p>
    </div>
  );
}

/** What an action kept: the pull request it opened or found, the comment it posted. */
function ReceiptCard({ name, receipt, readers }: { name: string; receipt: FlowReceipt; readers: string[] }) {
  const [copied, setCopied] = useState(false);
  const url = receipt.url;
  const header = (
    <div className="flex items-center gap-2 bg-green-tint px-3 py-2 text-13 font-semibold text-green-ink">
      <HugeiconsIcon icon={Invoice03Icon} size={14} strokeWidth={1.8} color="currentColor" />
      <span className="flex-1">Receipt</span>
      <span className="text-12 font-medium">saved {clock(receipt.at)}</span>
    </div>
  );
  const link = (text: string) =>
    url ? (
      <a href={url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
        {text}
      </a>
    ) : (
      text
    );
  return (
    <div data-flow-receipt className="space-y-3">
      {receipt.kind === "pull-request" ? (
        <Table
          header={header}
          rows={[
            ["Pull request", link(`#${receipt.number}${receipt.draft ? ", draft" : ""}`)],
            ["Matched by", receipt.matched ? `branch ${receipt.branch}, already open` : `opened from ${receipt.branch}`],
            ["Gave", readers.length ? `url, read by ${readers.join(", ")}` : "url"],
          ]}
        />
      ) : (
        <Table header={header} rows={[["Comment", link(`On ${receipt.issue}`)]]} />
      )}
      {receipt.kind === "pull-request" && (
        <p className="text-12 text-ink-3">
          If {name} restarts, this step finds #{receipt.number} and skips.
        </p>
      )}
      {url && (
        <div className="flex gap-2">
          <a href={url} target="_blank" rel="noreferrer" data-flow-receipt-open className={primaryButton}>
            <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={1.8} color="currentColor" />
            {receipt.kind === "pull-request" ? "Open on GitHub" : "Open on Linear"}
          </a>
          <button
            type="button"
            className={secondaryButton}
            onClick={() =>
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} strokeWidth={1.8} color="currentColor" />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}

/** A step the Run stopped at: its error, each try with its Chat, what has left the Mac, and Retry with a note. */
function FailedCard({
  name,
  step,
  state,
  run,
  canRetry,
  canOpen,
  onOpenChat,
  act,
}: {
  name: string;
  step: FlowStep;
  state: FlowStepRun;
  run: RoutineRun;
  canRetry: boolean;
  canOpen: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
  act: FlowAct;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const tries = [
    ...(state.tries ?? []),
    ...(state.startedAt
      ? [{ startedAt: state.startedAt, endedAt: state.endedAt ?? state.startedAt, error: state.error ?? "Failed", chatId: state.chatId }]
      : []),
  ];
  const receipts = Object.values(run.flow?.state ?? {}).flatMap((entry) => (entry.receipt ? [entry.receipt] : []));
  const left = receipts.length
    ? `Already done: ${receipts.map((receipt) => (receipt.kind === "pull-request" ? `pull request #${receipt.number}` : `a comment on ${receipt.issue}`)).join(", ")}.`
    : "No action receipt is recorded. Check the last Chat for any effects of its tools.";
  const lastChat = tries.toReversed().find((entry) => entry.chatId && canOpen(entry.chatId))?.chatId;
  return (
    <div data-flow-failed className="space-y-3">
      <Note icon={Alert02Icon} tone="bg-red-tint text-red-ink">
        {state.error || "The step failed."}
      </Note>
      {tries.length > 0 && (
        <div className="space-y-2">
          <p className="text-12 font-medium text-ink-2">Tries</p>
          <div className="divide-y divide-line rounded-control border border-line">
            {tries.map((entry, index) => (
              <div key={entry.startedAt} data-flow-try={index + 1} className="flex min-h-9 items-center gap-2 px-3 py-1.5">
                <HugeiconsIcon icon={CancelCircleIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-red" />
                <span className="min-w-0 flex-1 truncate text-13 text-ink" title={entry.error}>
                  Try {index + 1}, {tookText(entry.endedAt - entry.startedAt)}, {firstLine(entry.error)}
                </span>
                {entry.chatId && canOpen(entry.chatId) && (
                  <button type="button" onClick={() => onOpenChat(entry.chatId!)} className="shrink-0 text-12 font-medium text-accent-ink hover:underline">
                    Chat
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <Note icon={Shield01Icon}>{left} The Worktree and its commits stay.</Note>
      {noting && (
        <textarea
          aria-label="Note"
          data-flow-retry-note
          rows={3}
          className={textarea}
          placeholder="What should go differently this time?"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
      <div className="flex gap-2">
        {canRetry && (
          <button
            type="button"
            data-flow-retry
            disabled={busy}
            className={primaryButton}
            onClick={() => {
              if (!noting) return setNoting(true);
              setBusy(true);
              act("retry", note.trim() ? { note: note.trim() } : {}).finally(() => setBusy(false));
            }}
          >
            <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.8} color="currentColor" />
            {noting ? "Retry" : "Retry with a note"}
          </button>
        )}
        {lastChat && (
          <button type="button" className={secondaryButton} onClick={() => onOpenChat(lastChat)}>
            Open last Chat
          </button>
        )}
      </div>
      {canRetry && (
        <p className="text-12 text-ink-3">
          Retry runs {stepTitle(step)} again in the same Worktree{step.kind === "agent" ? " with your note added to the prompt" : ""}. Later steps run as usual.{" "}
          {name} keeps its place.
        </p>
      )}
    </div>
  );
}

/** The selected step of a Run, in the inspector: its approval, receipt, failure, output or why it didn't run. */
export function RunInspector({
  routine,
  run,
  stepId,
  canOpen,
  onOpenChat,
  act,
}: {
  routine: RoutineWithRuns;
  run: RoutineRun;
  stepId: string | null;
  canOpen: (chatKey: string) => boolean;
  onOpenChat: (chatKey: string) => void;
  act: FlowAct;
}) {
  const flow = run.flow!;
  const name = runName(routine, run);
  const issue = run.event?.kind === "linear" ? run.event.issue : null;
  if (stepId === "trigger" || !stepId) {
    return (
      <InspectorCard kind="trigger" title={triggerTitle(routine.trigger)} subtitle={triggerRunText(routine, run)} data-flow-run-inspector="trigger">
        {issue ? (
          <div className="space-y-2">
            <p className="text-13 text-ink">
              {issue.key} {issue.title}
            </p>
            <p className="text-12 text-ink-3">
              {issue.state}
              {issue.labels.length ? `, ${issue.labels.join(", ")}` : ""}
            </p>
            {issue.url && (
              <a href={issue.url} target="_blank" rel="noreferrer" className="text-13 font-medium text-accent-ink hover:underline">
                Open on Linear
              </a>
            )}
          </div>
        ) : (
          <p className="text-13 text-ink-2">
            {flow.dryRun ? "Simulation of the draft. Agents use sample or saved fields. Actions and waits do not run." : "The trigger started this Run."}
          </p>
        )}
      </InspectorCard>
    );
  }
  const step = flattenSteps(flow.steps).find((entry) => entry.step.id === stepId)?.step;
  if (!step) return null;
  const row = runRows(flow).find((entry) => entry.kind === "step" && entry.step.id === stepId);
  const status = row?.kind === "step" ? row.status : "pending";
  const state = flow.state[step.id] ?? null;
  const pendingApproval = status === "waiting" && state?.approval && !state.approval.decision;
  const stopped = failedStep(flow);
  const subtitle = (() => {
    if (!state || status === "pending") return flow.status === "failed" || flow.status === "ended" ? "Did not run" : "Not started";
    if (status === "not-taken") return "Not taken";
    if (status === "not-run") return stopped ? `Did not run: the Run stopped at ${stepTitle(stopped)}` : "Did not run";
    if (pendingApproval) return step.kind === "pull-request" ? "Action, asks you before it runs" : "Approval, waiting for you";
    if (status === "waiting") return "Waiting";
    if (status === "running") return state.startedAt ? `Running since ${clock(state.startedAt)}` : "Running";
    if (status === "failed") {
      const tries = (state.tries?.length ?? 0) + 1;
      return `Stopped${state.endedAt ? ` at ${clock(state.endedAt)}` : ""}${tries > 1 ? ` after ${tries} tries` : ""}`;
    }
    if (status === "skipped") return state.summary || "Skipped";
    const approval = state.approval?.decision === "approved" && state.approval.decidedAt ? `, approved at ${clock(state.approval.decidedAt)}` : "";
    return `Done${state.endedAt ? ` at ${clock(state.endedAt)}` : ""}${approval}`;
  })();
  const readers =
    state?.receipt?.kind === "pull-request"
      ? flattenSteps(flow.steps)
          .filter((entry) => stepReads(entry.step).includes(`${step.id}.url`))
          .map((entry) => entry.step.name)
      : [];
  const output = state?.output && Object.keys(state.output).length > 0 ? state.output : null;
  return (
    <InspectorCard kind={step.kind} title={stepTitle(step)} subtitle={subtitle} data-flow-run-inspector={step.id}>
      {pendingApproval && <ApprovalCard name={name} step={step} state={state!} act={act} />}
      {state?.approval?.decision && (
        <p data-flow-decision={state.approval.decision} className="text-13 text-ink-2">
          {state.approval.decision === "approved"
            ? `Approved${state.approval.decidedAt ? ` at ${clock(state.approval.decidedAt)}` : ""}`
            : state.approval.decision === "rejected"
              ? `Rejected${state.approval.decidedAt ? ` at ${clock(state.approval.decidedAt)}` : ""}${state.approval.reason ? `: ${state.approval.reason}` : ""}`
              : "No answer in time"}
        </p>
      )}
      {state?.receipt && <ReceiptCard name={name} receipt={state.receipt} readers={readers} />}
      {status === "failed" && state && (
        <FailedCard name={name} step={step} state={state} run={run} canRetry={flow.status === "failed"} canOpen={canOpen} onOpenChat={onOpenChat} act={act} />
      )}
      {output && <Table rows={Object.entries(output).map(([key, value]) => [key, typeof value === "boolean" ? (value ? "yes" : "no") : String(value)])} />}
      {state?.note && <Note icon={RefreshIcon}>Your note on retry: {state.note}</Note>}
      {status !== "failed" && state?.chatId && canOpen(state.chatId) && (
        <button
          type="button"
          onClick={() => onOpenChat(state.chatId!)}
          className="inline-flex h-8 items-center rounded-control border border-line-strong bg-surface px-3 text-13 font-medium text-ink transition-colors hover:bg-hover"
        >
          Open Chat
        </button>
      )}
    </InspectorCard>
  );
}
