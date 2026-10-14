import { memo, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive02Icon, Cancel01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { advisorAction, subagentRoleLabel, subagentActivityLabel } from "@milagre/shared/agent-activity";
import type { ModelProvider, Subagent } from "../../model";
import { subagentActive, subagentFinished } from "../../lib/subagents";
import { useSubagentDetails } from "../../lib/subagent-transcripts";
import { Markdown } from "../markdown/Markdown";
import { ProviderLogo } from "../ProviderLogo";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
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
function elapsed(agent: Subagent, now: number) {
  const seconds = Math.max(0, Math.floor(((agent.endedAt ?? now) - agent.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function AdvisorControls({ agent, onStop, onRetry }: { agent: Subagent; onStop?: (id: string) => void; onRetry?: (id: string) => void }) {
  const action = advisorAction(agent);
  if (!action || !(action === "stop" ? onStop : onRetry)) return null;
  return (
    <button
      type="button"
      data-advisor-stop={action === "stop" || undefined}
      data-advisor-retry={action === "retry" || undefined}
      aria-label={`${action === "stop" ? "Stop" : "Retry"} ${agent.title}`}
      onClick={() => (action === "stop" ? onStop : onRetry)?.(agent.id)}
      className="rounded px-2 py-1 text-[11px] text-ink-2 hover:bg-hover focus-visible:outline-2"
    >
      {action === "stop" ? "Stop" : "Retry"}
    </button>
  );
}
export const SubagentTranscript = memo(function SubagentTranscript({
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
  // oxlint-disable-next-line react/purity -- Date.now() only seeds the initial clock state; an effect keeps it current
  const [now, setNow] = useState(Date.now());
  const { agent, transcript, status } = useSubagentDetails(chatKey, sent);
  const running = subagentActive(agent);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <div className="space-y-4 p-3" data-slot="subagent-transcript">
      <div className="flex flex-wrap gap-3 text-[12px] text-ink-3">
        <span>{subagentActivityLabel(agent)}</span>
        <span>{elapsed(agent, now)}</span>
        <span>{subagentRoleLabel(agent) ?? "Read-only transcript"}</span>
        {agent.model && <span>{agent.model}</span>}
        <AdvisorControls agent={agent} onStop={onStop} onRetry={onRetry} />
      </div>
      {agent.prompt && (
        <div className="rounded-lg bg-hover p-3">
          <p className="mb-1 text-[11px] text-ink-3">Task</p>
          <p className="whitespace-pre-wrap break-words text-[13px]">{agent.prompt}</p>
        </div>
      )}
      {agent.latestActivity && <p className="break-words text-[12px] text-ink-3">{agent.latestActivity}</p>}
      {transcript.map((entry) => (
        <div key={entry.id} className="min-w-0 break-words text-[13px]">
          {entry.kind === "tool" ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line p-3 font-mono text-[12px]">{entry.text}</pre>
          ) : (
            <Markdown text={entry.text} />
          )}
        </div>
      ))}
      {status === "loading" && (
        <p data-subagent-loading className="py-6 text-[13px] text-ink-3">
          Loading activity…
        </p>
      )}
      {status === "failed" && (
        <p data-subagent-failed className="py-6 text-[13px] text-ink-3">
          Couldn't load this subagent's activity. Open it again to retry.
        </p>
      )}
      {status === "ready" && !transcript.length && <p className="py-6 text-[13px] text-ink-3">No child output received yet.</p>}
    </div>
  );
});

/** A "Subagents n" pill that grows in place into their list (see PillMorph). Archiving affects views, not provider execution. */
export function SubagentTrack({
  chatKey,
  agents,
  provider = "codex",
  onOpenCanvas,
  onArchiveFinished,
  onArchive,
  onStop,
  onRetry,
}: {
  chatKey?: string | null;
  agents: Subagent[];
  provider?: ModelProvider;
  onOpenCanvas: () => void;
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
  const actionClass = "flex size-6 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 disabled:opacity-40";
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
      width={child ? 480 : 420}
      height={child ? 520 : 360}
      pill={{
        leading: visible.some(subagentActive) ? <SpinnerRing size={12} /> : undefined,
        label: "Subagents",
        count: visible.length,
        className: "gap-2",
        "aria-label": `Subagents, ${visible.length}${visible.some(subagentActive) ? `, ${visible.filter(subagentActive).length} running` : ""}`,
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
            buttons[next].focus();
            buttons[next].scrollIntoView({ block: "nearest" });
          }}
        >
          {child ? (
            <>
              <header className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-2">
                <button type="button" onClick={() => setSelected(null)} className="rounded px-1 text-[12px] text-ink-3 hover:text-ink">
                  Back
                </button>
                <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{child.title}</h2>
                <button type="button" aria-label="Close subagents" onClick={close} className={actionClass}>
                  <HugeiconsIcon icon={Cancel01Icon} size={14} />
                </button>
              </header>
              <ScrollArea>
                <SubagentTranscript chatKey={chatKey} agent={child} onStop={onStop} onRetry={onRetry} />
              </ScrollArea>
            </>
          ) : (
            <>
              {!archived && (
                <div className="mb-1 flex shrink-0 items-center gap-1 border-b border-line pb-1">
                  <button
                    type="button"
                    data-subagent-archive-finished
                    disabled={!onArchiveFinished || !visible.some(subagentFinished)}
                    onClick={onArchiveFinished}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] text-ink-2 hover:bg-hover focus-visible:outline-2 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <HugeiconsIcon icon={Archive02Icon} size={14} />
                    Archive finished subagents
                  </button>
                  <Tooltip label="Watch subagents">
                    <button
                      type="button"
                      aria-label="Open subagent canvas"
                      onClick={() => {
                        setOpened(false);
                        onOpenCanvas();
                      }}
                      className={`${actionClass} mr-1 shrink-0`}
                    >
                      <HugeiconsIcon icon={ViewIcon} size={17} />
                    </button>
                  </Tooltip>
                </div>
              )}
              <ScrollArea as="ul">
                {rows.map((agent) => (
                  <li key={agent.id} data-subagent-row className="group flex items-center gap-1 rounded-md px-1 hover:bg-hover focus-within:bg-hover">
                    <button
                      type="button"
                      data-subagent-open
                      onClick={() => setSelected(agent.id)}
                      title={`${agent.title} (${labels[agent.status]})`}
                      className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-1 text-left text-[13px] focus-visible:outline-2"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">
                        {subagentActive(agent) ? <SpinnerRing size={12} /> : <ProviderLogo provider={agent.provider ?? provider} size={14} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate">{agent.title}</span>
                        {subagentRoleLabel(agent) && <span className="block text-[11px] text-ink-3">{subagentRoleLabel(agent)}</span>}
                      </span>
                    </button>
                    <AdvisorControls agent={agent} onStop={onStop} onRetry={onRetry} />
                    <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                      <Tooltip label={archived ? "Restore subagent" : "Archive subagent"}>
                        <button
                          type="button"
                          aria-label={`${archived ? "Restore" : "Archive"} ${agent.title}`}
                          disabled={!onArchive || (agent.source === "milagre-advisor" && subagentActive(agent))}
                          onClick={() => onArchive?.(agent.id, !archived)}
                          className={actionClass}
                        >
                          <HugeiconsIcon icon={Archive02Icon} size={14} />
                        </button>
                      </Tooltip>
                    </span>
                  </li>
                ))}
              </ScrollArea>
              {!rows.length && <p className="px-3 py-5 text-[12px] text-ink-3">{archived ? "No archived subagents." : "No subagents to show."}</p>}
              {(archivedCount > 0 || archived) && (
                <button
                  type="button"
                  data-subagent-archived-toggle
                  onClick={() => setArchived(!archived)}
                  className="mt-1 border-t border-line px-2 py-2 text-left text-[11px] text-ink-3 hover:text-ink"
                >
                  {archived ? "Back to subagents" : `Archived (${archivedCount})`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </PillMorph>
  );
}
