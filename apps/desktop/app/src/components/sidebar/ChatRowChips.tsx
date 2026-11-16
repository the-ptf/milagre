import { issueChipLabel, type LinearIssue } from "@milagre/shared/linear";
import { LinearLogo } from "../ProviderLogo";
import { createContext, useContext } from "react";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import Tooltip from "@/components/primitives/Tooltip";
import type { PullRequest } from "@/model";
import { prLook } from "@/lib/pr-look";
import { HugeIcon } from "./ChatMarks";
import type { SidebarRecent } from "./ChatRow";

export const PullRequestOpenContext = createContext<((item: SidebarRecent, pr: PullRequest) => boolean) | null>(null);

export function LinearIssueChip({ issue, inbox = false }: { issue: LinearIssue; inbox?: boolean }) {
  return (
    <button
      type="button"
      data-linear-issue-chip
      title={inbox ? `${issueChipLabel(issue)} · ${issue.title}` : issue.title}
      aria-label={`Open Linear issue ${issue.key}: ${issue.title}`}
      onClick={(event) => {
        event.stopPropagation();
        window.open(issue.url, "_blank", "noopener,noreferrer");
      }}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-inline text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${inbox ? "pointer-events-auto shrink-0 text-ink-2" : "text-ink-3"}`}
    >
      <LinearLogo size={11} />
      <span className="truncate">{inbox ? issue.key : issueChipLabel(issue)}</span>
    </button>
  );
}

export function PullRequestChip({
  pr,
  item,
  labelled,
  inbox = false,
  edge = false,
  count = 1,
}: {
  pr: PullRequest;
  item: SidebarRecent;
  labelled: boolean;
  inbox?: boolean;
  edge?: boolean;
  count?: number;
}) {
  const openInPanel = useContext(PullRequestOpenContext);
  const look = prLook(pr);
  const several = edge && count > 1;
  const label = !edge ? look.description : several ? `${count} pull requests` : [`#${pr.number}`, pr.title].filter(Boolean).join(" ");
  const content =
    edge && !several ? (
      <span data-chat-pr-tooltip className="flex min-w-0 max-w-[264px] items-center gap-1.5">
        <span aria-hidden className={`flex shrink-0 ${look.toneClass}`}>
          <HugeIcon icon={look.glyph} size={12} />
        </span>
        <span className="shrink-0 font-mono tabular-nums">#{pr.number}</span>
        {pr.title && <span className="min-w-0 truncate">{pr.title}</span>}
      </span>
    ) : undefined;
  return (
    <Tooltip label={label} content={content} side="bottom" align={edge ? "end" : "start"} className={inbox ? "pointer-events-auto shrink-0" : "min-w-0"}>
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={several ? `Open ${look.spoken}, ${count} pull requests` : `Open ${look.spoken}`}
        data-chat-pr
        data-chat-pr-state={look.icon}
        className={`group/pr inline-flex min-w-0 items-center gap-1 rounded-inline text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums no-underline transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${edge ? look.labelClass : inbox ? "text-ink-2" : "text-ink-3"}`}
        onClick={(event) => {
          event.stopPropagation();
          if (!event.metaKey && openInPanel?.(item, pr)) event.preventDefault();
        }}
      >
        <span aria-hidden className={`inline-flex group-hover/pr:hidden group-focus-visible/pr:hidden ${look.toneClass}`}>
          <HugeIcon icon={look.glyph} size={12} />
        </span>
        <span aria-hidden data-chat-pr-link className="hidden group-hover/pr:inline-flex group-focus-visible/pr:inline-flex">
          <HugeIcon icon={LinkSquare02Icon} size={12} />
        </span>
        <span className="truncate">{edge ? (several ? `+${count}` : pr.number) : `#${pr.number}`}</span>
        {labelled && look.label && <span className={`shrink-0 ${look.labelClass}`}>{look.label}</span>}
      </a>
    </Tooltip>
  );
}
