import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDisplayNow } from "../../lib/display-clock";
import { formatElapsed } from "@milagre/shared/display-clock";
import {
  AlertCircleIcon,
  Archive02Icon,
  ArrowLeft01Icon,
  ArrowShrink02Icon,
  CommandLineIcon,
  File01Icon,
  Image01Icon,
  PencilEdit01Icon,
  ScrollIcon,
  Search01Icon,
  Tick02Icon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { advisorAction, subagentRoleLabel, subagentActivityLabel } from "@milagre/shared/agent-activity";
import { lastSaid, planCounts, plainTitle, subagentOutcome, subagentSteps, toolChips, toolSummary, type SubagentStep } from "@milagre/shared/subagent-glance";
import { qaFleetFirst, qaPersona, type QaPersona } from "@milagre/shared/qa-personas";
import type { AgentTask, ModelProvider, Subagent, ToolCategory } from "../../model";
import { subagentActive, subagentFinished } from "../../lib/subagents";
import { useSubagentDetails } from "../../lib/subagent-transcripts";
import { Markdown } from "../markdown/Markdown";
import { ProviderLogo } from "../ProviderLogo";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { SectionLabel } from "../primitives/SectionLabel";
import { EmptyState } from "../primitives/EmptyState";
import { InlineError } from "../primitives/InlineError";
import { PillMorph } from "../motion/PillMorph";

const labels: Record<Subagent["status"], string> = {
  initializing: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  unknown: "Status unavailable",
};
const chipIcons: Record<ToolCategory, typeof CommandLineIcon> = {
  commands: CommandLineIcon,
  images: Image01Icon,
  reads: File01Icon,
  searches: Search01Icon,
  edits: PencilEdit01Icon,
  other: WrenchIcon,
};
// What the panel calls "now" when the latest activity is only a phase, not a tool call.
const PHASES = new Set(["Responding", "Thinking", "Finished"]);

const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

function elapsed(agent: Subagent, now: number) {
  return formatElapsed((agent.endedAt ?? now) - agent.startedAt);
}

function AdvisorControls({ agent, onStop, onRetry }: { agent: Subagent; onStop?: (id: string) => void; onRetry?: (id: string) => void }) {
  const action = advisorAction(agent);
  if (!action || !(action === "stop" ? onStop : onRetry)) return null;
  return (
    <Button
      variant="secondary"
      size={24}
      data-advisor-stop={action === "stop" || undefined}
      data-advisor-retry={action === "retry" || undefined}
      aria-label={`${action === "stop" ? "Stop" : "Retry"} ${agent.title}`}
      onClick={() => (action === "stop" ? onStop : onRetry)?.(agent.id)}
    >
      {action === "stop" ? "Stop" : "Retry"}
    </Button>
  );
}

/** A QA persona's face (qa-personas.ts): a solid blob with white eyes, the same in light and dark. */
function PersonaAvatar({ persona, size, overlap }: { persona: QaPersona; size: number; overlap?: boolean }) {
  return (
    <svg
      aria-hidden
      data-qa-persona={persona.type}
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      className={`shrink-0 overflow-visible ${overlap ? "-ml-1.5 first:ml-0" : ""}`}
    >
      {persona.face.map(({ type: Shape, props }, index) => (
        <Shape key={index} {...props} />
      ))}
    </svg>
  );
}

function QaTag({ persona }: { persona: QaPersona }) {
  return (
    <span className="shrink-0 rounded-inline px-1 py-px text-10 font-semibold" style={{ background: persona.tint, color: persona.ink }}>
      QA
    </span>
  );
}

/** Who the persona plays, above its plan: on its own colour, so it reads the same in light and dark. */
function PersonaCard({ persona }: { persona: QaPersona }) {
  return (
    <section data-qa-persona-card className="flex flex-col gap-2 rounded-card p-3" style={{ background: persona.tint, color: persona.ink }}>
      <span className="flex items-center gap-3">
        <PersonaAvatar persona={persona} size={40} />
        <span className="flex min-w-0 flex-col">
          <span className="text-15 font-semibold">{persona.title}</span>
          <span className="text-12">{persona.tagline}</span>
        </span>
      </span>
      {persona.chips && (
        <span className="flex flex-wrap gap-1.5">
          {persona.chips.map((chip) => (
            <span key={chip} className="rounded-chip bg-paper/60 px-2 py-0.5 text-11">
              {chip}
            </span>
          ))}
        </span>
      )}
    </section>
  );
}

function StatusIcon({ agent, provider }: { agent: Subagent; provider: ModelProvider }) {
  if (subagentActive(agent)) return <SpinnerRing size={12} />;
  if (agent.status === "failed") return <Icon icon={AlertCircleIcon} size={14} />;
  // A finished one shows whose it is: a Chat's subagents can run on another provider (advisors, Antigravity).
  return <ProviderLogo provider={agent.provider ?? provider} size={14} />;
}

function StepNumber({ value, current }: { value: number; current?: boolean }) {
  return (
    <span
      aria-hidden
      className={`mt-0.5 min-w-4 shrink-0 rounded-inline px-1 text-center text-11 tabular-nums ${current ? "bg-hover-2 text-ink-2" : "bg-hover text-ink-3"}`}
    >
      {value}
    </span>
  );
}

function ToolChips({ counts }: { counts?: SubagentStep["tools"] }) {
  const chips = toolChips(counts);
  if (!chips.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span key={chip.category} className="flex items-center gap-1 rounded-inline bg-hover px-1 py-0.5 text-10 text-ink-3">
          <Icon icon={chipIcons[chip.category]} size={12} />
          {chip.label}
        </span>
      ))}
    </span>
  );
}

/** What it says now and the tool it runs, under the current item or step. */
function NowLines({ said, tool }: { said?: string; tool?: string }) {
  return (
    <>
      {said && (
        <p className="line-clamp-2 text-13 text-ink-2" title={said}>
          {said}
        </p>
      )}
      {tool && <p className="truncate text-11 text-ink-3">{tool}</p>}
    </>
  );
}

/** The subagent's own to-do list, as the Tasks popover draws a Chat's: the current item carries what it does now. */
function PlanList({ tasks, said, tool }: { tasks: AgentTask[]; said?: string; tool?: string }) {
  const counts = planCounts(tasks)!;
  return (
    <section data-subagent-plan className="-mx-1.5 flex flex-col gap-0.5">
      <SectionLabel as="h3" className="flex justify-between px-1.5 pb-1">
        <span>Plan</span>
        <span className="tabular-nums">
          {counts.done} of {counts.total} done
        </span>
      </SectionLabel>
      <ul className="flex flex-col gap-0.5">
        {tasks.map((task, index) => {
          const current = task.status === "in_progress";
          return (
            <li
              key={task.id}
              data-status={task.status}
              className={`flex flex-col gap-1.5 rounded-control p-1.5 text-13 ${current ? "bg-hover ring-1 ring-line-strong" : ""}`}
            >
              <span className="flex items-start gap-2">
                <StepNumber value={index + 1} current={current} />
                <span className={`min-w-0 flex-1 break-words ${task.status === "completed" ? "text-ink-3" : current ? "font-medium text-ink" : "text-ink-2"}`}>
                  {current && task.activeForm ? task.activeForm : task.content}
                </span>
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink-3">
                  {current ? (
                    <SpinnerRing size={12} />
                  ) : task.status === "completed" ? (
                    <Icon icon={Tick02Icon} size={14} />
                  ) : (
                    <span aria-hidden className="size-3 rounded-full border-[1.5px] border-line-strong" />
                  )}
                </span>
              </span>
              {current && (said || tool) && (
                <span className="flex flex-col gap-0.5 pl-6">
                  <NowLines said={said} tool={tool} />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What it said, step by step, with the tool calls after each counted. */
function StepList({ steps, title }: { steps: SubagentStep[]; title: string }) {
  if (!steps.length) return null;
  return (
    <section data-subagent-steps className="-mx-1.5 flex flex-col gap-0.5">
      <SectionLabel as="h3" className="px-1.5 pb-1">
        {title}
      </SectionLabel>
      <ol className="flex flex-col gap-0.5">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-start gap-2 p-1.5 text-13">
            <StepNumber value={index + 1} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="line-clamp-2 break-words text-ink-3" title={step.text || undefined}>
                {step.said || "Getting started"}
              </span>
              <ToolChips counts={step.tools} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Text clamped to a few lines, with Show all when it doesn't fit. */
function Clamped({ children, lines, label }: { children: ReactNode; lines: 2 | 6; label: string }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, children]);
  return (
    <div className="flex flex-col items-start gap-1">
      <div ref={box} className={`min-w-0 self-stretch break-words ${open ? "" : lines === 2 ? "line-clamp-2" : "line-clamp-6"}`}>
        {children}
      </div>
      {(clipped || open) && (
        <button
          type="button"
          aria-label={`${open ? "Show less of" : "Show all of"} ${label}`}
          onClick={() => setOpen(!open)}
          className="relative text-11 text-ink-3 transition-colors duration-fast before:absolute before:-inset-x-1 before:-inset-y-1.5 hover:text-ink"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/**
 * One subagent at a glance: its own plan (or, without one, what it said step by step), what it does now, its task and
 * outcome. The whole transcript sits behind Full log.
 */
export const SubagentDetail = memo(function SubagentDetail({
  chatKey,
  agent: sent,
  onStop,
  onRetry,
}: {
  /**
   * The Chat the subagent belongs to, to read what the host leaves out: the start of its transcript, or all but the
   * summary of an archived one.
   */
  chatKey?: string | null;
  agent: Subagent;
  onStop?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { agent, transcript, status } = useSubagentDetails(chatKey, sent);
  const running = subagentActive(agent);
  const now = useDisplayNow(1000, running);
  const [log, setLog] = useState(false);
  const steps = subagentSteps(transcript);
  const current = steps.at(-1);
  const said = agent.progress?.said ?? current?.said;
  const latest = agent.latestActivity && !PHASES.has(agent.latestActivity) ? agent.latestActivity : current?.lastTool;
  const tool = running && latest ? plainTitle(latest) : undefined;
  // Its final answer; else the last activity a finished provider reported, when it is more than a phase.
  const result =
    transcript.findLast((entry) => entry.kind === "message" && (entry.id === "result" || entry.id === "summary"))?.text ??
    (agent.latestActivity && !PHASES.has(agent.latestActivity) ? agent.latestActivity : undefined);
  const plan = agent.tasks?.length ? agent.tasks : undefined;
  const totals = toolSummary(agent.progress?.tools);
  const persona = qaPersona(agent);
  return (
    <div className="flex flex-col gap-4 p-3" data-slot="subagent-transcript">
      {persona && <PersonaCard persona={persona} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-ink-3">
        <span className="text-ink-2">{subagentActivityLabel(agent)}</span>
        <span className="tabular-nums">{elapsed(agent, now)}</span>
        {subagentRoleLabel(agent) && <span>{subagentRoleLabel(agent)}</span>}
        {agent.model && <span>{agent.model}</span>}
        <span className="flex-1" />
        <AdvisorControls agent={agent} onStop={onStop} onRetry={onRetry} />
      </div>
      {plan ? (
        <PlanList tasks={plan} said={said} tool={running ? [tool, totals && `${totals} so far`].filter(Boolean).join(" · ") : undefined} />
      ) : (
        <>
          {running && current && (
            <section data-subagent-now className="flex flex-col gap-1.5 rounded-card bg-hover p-3 ring-1 ring-line-strong">
              <SectionLabel as="h3" className="flex items-center gap-1.5">
                <SpinnerRing size={12} />
                Now · step {steps.length}
              </SectionLabel>
              <p className="line-clamp-2 text-15 font-medium break-words text-ink" title={current.text || undefined}>
                {current.said || subagentActivityLabel(agent)}
              </p>
              {tool && <p className="truncate text-12 text-ink-3">{tool}</p>}
            </section>
          )}
          <StepList steps={running ? steps.slice(0, -1) : steps} title={running ? "Earlier" : "Steps"} />
        </>
      )}
      {!running && result && (
        <section data-subagent-result className="flex flex-col gap-1">
          <SectionLabel as="h3">Result</SectionLabel>
          <Clamped lines={6} label="the result">
            <div className="text-13">
              <Markdown text={result} />
            </div>
          </Clamped>
        </section>
      )}
      {agent.prompt && (
        <section className="flex flex-col gap-1">
          <SectionLabel as="h3">Task</SectionLabel>
          <Clamped lines={2} label="the task">
            <p className="text-13 whitespace-pre-wrap text-ink-2">{agent.prompt}</p>
          </Clamped>
        </section>
      )}
      {status === "loading" && (
        <p data-subagent-loading role="status" className="flex items-center gap-2 py-6 text-13 text-ink-3">
          <SpinnerRing size={12} />
          Loading activity…
        </p>
      )}
      {status === "failed" && (
        <InlineError data-subagent-failed className="py-6">
          Couldn't load this subagent's activity. Open it again to retry.
        </InlineError>
      )}
      {status === "ready" && !transcript.length && !plan && <EmptyState size="compact" title="No child output received yet" />}
      {transcript.length > 0 && (
        <section className="flex flex-col gap-3">
          <button
            type="button"
            data-subagent-log-toggle
            aria-expanded={log}
            onClick={() => setLog(!log)}
            className="relative flex items-center gap-1.5 self-start text-11 text-ink-3 transition-colors duration-fast before:absolute before:-inset-x-1 before:-inset-y-1.5 hover:text-ink"
          >
            <Icon icon={ScrollIcon} size={12} />
            {log ? "Hide full log" : `Full log (${entries(agent.transcriptLength ?? transcript.length)})`}
          </button>
          {log &&
            transcript.map((entry) => (
              <div key={entry.id} data-subagent-log-entry className="min-w-0 break-words text-13">
                {entry.kind === "tool" ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-control border border-line p-3 font-mono text-12">{entry.text}</pre>
                ) : (
                  <Markdown text={entry.text} />
                )}
              </div>
            ))}
        </section>
      )}
    </div>
  );
});

/** A list row: status, title, time, what it says now (or its outcome), and how far it got. */
function SubagentRow({ agent, provider, now }: { agent: Subagent; provider: ModelProvider; now: number }) {
  const running = subagentActive(agent);
  const counts = planCounts(agent.tasks);
  // A subagent saved before the host kept its totals still has the tail of its transcript.
  const said = agent.progress?.said ?? lastSaid(subagentSteps(agent.transcript));
  const line = running ? (said ?? subagentActivityLabel(agent)) : (subagentOutcome(agent.transcript) ?? said ?? subagentActivityLabel(agent));
  const meta = [
    counts ? `${counts.done} of ${counts.total}` : agent.progress?.steps ? `Step ${agent.progress.steps}` : "",
    toolSummary(agent.progress?.tools),
    subagentRoleLabel(agent),
  ]
    .filter(Boolean)
    .join(" · ");
  const persona = qaPersona(agent);
  return (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      {persona ? (
        <PersonaAvatar persona={persona} size={28} />
      ) : (
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink-3">
          <StatusIcon agent={agent} provider={provider} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span data-subagent-title className={`min-w-0 truncate ${persona ? "font-semibold" : "flex-1 font-medium"} ${running ? "text-ink" : "text-ink-2"}`}>
            {persona?.name ?? agent.title}
          </span>
          {persona && (
            <>
              <QaTag persona={persona} />
              <span className="flex-1" />
              {running ? <SpinnerRing size={12} /> : agent.status === "failed" && <Icon icon={AlertCircleIcon} size={12} />}
            </>
          )}
          <span className="shrink-0 text-11 text-ink-3 tabular-nums">{elapsed(agent, now)}</span>
        </span>
        {line && (
          <span className={`line-clamp-2 break-words ${running ? "text-ink-2" : "text-ink-3"}`} title={line}>
            {line}
          </span>
        )}
        {meta && <span className="truncate text-11 text-ink-3">{meta}</span>}
      </span>
    </span>
  );
}

/** A "Subagents n" pill that grows in place into their list (see PillMorph). Archiving affects views, not provider execution. */
export function SubagentTrack({
  chatKey,
  agents,
  provider = "codex",
  onArchiveFinished,
  onArchive,
  onStop,
  onRetry,
}: {
  chatKey?: string | null;
  agents: Subagent[];
  provider?: ModelProvider;
  onArchiveFinished?: () => void;
  onArchive?: (id: string, archived: boolean) => void;
  onStop?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const visible = agents.filter((agent) => !agent.archived);
  const archivedCount = agents.length - visible.length;
  const rows = agents.filter((agent) => Boolean(agent.archived) === archived);
  const child = rows.find((agent) => agent.id === selected);
  const running = visible.filter(subagentActive).length;
  const done = visible.filter(subagentFinished).length;
  const now = useDisplayNow(1000, opened && rows.some(subagentActive));
  // The QA fleet's personas come first, under their own header (qa-personas.ts).
  const { fleet, others } = qaFleetFirst(rows);
  const row = (agent: Subagent) => (
    <li
      key={agent.id}
      data-subagent-row
      className="group flex items-start gap-1 rounded-control px-1 transition-colors duration-fast hover:bg-hover focus-within:bg-hover"
    >
      <button
        type="button"
        data-subagent-open
        onClick={() => setSelected(agent.id)}
        title={`${agent.title} (${labels[agent.status]})`}
        className="flex min-w-0 flex-1 py-2 pl-1 text-left text-13"
      >
        <SubagentRow agent={agent} provider={provider} now={now} />
      </button>
      <span className="flex shrink-0 items-center gap-1 pt-1.5">
        <AdvisorControls agent={agent} onStop={onStop} onRetry={onRetry} />
        <span className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <Tooltip label={archived ? "Restore subagent" : "Archive subagent"}>
            <IconButton
              label={`${archived ? "Restore" : "Archive"} ${agent.title}`}
              icon={Archive02Icon}
              size={24}
              disabled={!onArchive || (agent.source === "milagre-advisor" && subagentActive(agent))}
              onClick={() => onArchive?.(agent.id, !archived)}
            />
          </Tooltip>
        </span>
      </span>
    </li>
  );
  return (
    <PillMorph
      shown={agents.length > 0 && (visible.length > 0 || opened)}
      slot="subagent-track"
      panelSlot="subagent-popover"
      title="Subagents"
      tooltip="Subagents"
      opened={opened}
      onOpenChange={(next) => {
        if (next) {
          setSelected(null);
          setArchived(false);
        }
        setOpened(next);
      }}
      width={child ? 440 : 420}
      height={child ? 600 : 460}
      pill={{
        leading: running ? <SpinnerRing size={12} /> : undefined,
        label: "Subagents",
        count: visible.length,
        className: "gap-2",
        "aria-label": `Subagents, ${visible.length}${running ? `, ${running} running` : ""}`,
      }}
    >
      {(close) => (
        <div
          className="flex min-h-0 flex-col p-1"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-subagent-open]")];
            if (!buttons.length) return;
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
            buttons[next]?.scrollIntoView({ block: "nearest" });
          }}
        >
          {child ? (
            <>
              <header className="flex shrink-0 items-center gap-2 border-b border-line px-1.5 py-1.5">
                <IconButton label="Back to subagents" icon={ArrowLeft01Icon} size={24} onClick={() => setSelected(null)} />
                <h2 className="min-w-0 flex-1 truncate text-13 font-medium">{qaPersona(child)?.name ?? child.title}</h2>
                <IconButton label="Collapse subagents" icon={ArrowShrink02Icon} size={24} onClick={close} />
              </header>
              <ScrollArea>
                <SubagentDetail chatKey={chatKey} agent={child} onStop={onStop} onRetry={onRetry} />
              </ScrollArea>
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 px-2 pt-1 pb-1">
                <SectionLabel as="h3" className="flex flex-1 items-center justify-between">
                  <span>{archived ? "Archived" : "Subagents"}</span>
                  {!archived && <span className="tabular-nums">{[running && `${running} running`, done && `${done} done`].filter(Boolean).join(" · ")}</span>}
                </SectionLabel>
                <IconButton label="Collapse subagents" icon={ArrowShrink02Icon} size={24} onClick={close} className="-my-1" />
              </div>
              <ScrollArea as="ul" className="flex flex-col gap-0.5">
                {fleet.length > 0 && (
                  <li data-qa-fleet className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-12">
                    <span className="flex pl-1.5">
                      {fleet.slice(0, 5).map((agent) => (
                        <PersonaAvatar key={agent.id} persona={qaPersona(agent)!} size={18} overlap />
                      ))}
                    </span>
                    <span className="flex-1 font-semibold text-ink-2">QA fleet</span>
                    <span className="text-11 text-ink-3">
                      {fleet.length} {fleet.length === 1 ? "persona" : "personas"}
                    </span>
                  </li>
                )}
                {fleet.map(row)}
                {fleet.length > 0 && others.length > 0 && <li aria-hidden className="mx-2 my-1 border-t border-line" />}
                {others.map(row)}
              </ScrollArea>
              {!rows.length && <EmptyState size="compact" title={archived ? "No archived subagents" : "No subagents to show"} />}
              <footer className="mt-1 flex shrink-0 items-center gap-1 border-t border-line pt-1">
                {archived ? (
                  <Button variant="quiet" size={24} data-subagent-archived-toggle onClick={() => setArchived(false)}>
                    <Icon icon={ArrowLeft01Icon} size={12} />
                    Back to subagents
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="quiet"
                      size={24}
                      data-subagent-archive-finished
                      disabled={!onArchiveFinished || !visible.some(subagentFinished)}
                      onClick={onArchiveFinished}
                    >
                      <Icon icon={Archive02Icon} size={12} />
                      Archive finished
                    </Button>
                    {archivedCount > 0 && (
                      <Button variant="quiet" size={24} data-subagent-archived-toggle onClick={() => setArchived(true)}>
                        Archived ({archivedCount})
                      </Button>
                    )}
                  </>
                )}
              </footer>
            </>
          )}
        </div>
      )}
    </PillMorph>
  );
}
