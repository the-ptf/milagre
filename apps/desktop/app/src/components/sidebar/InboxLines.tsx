import { ChatTitle } from "./ChatTitle";
import { type LinearIssue } from "@milagre/shared/linear";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Fragment, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, BubbleChatIcon, Link04Icon, PinIcon, Pulse01Icon } from "@hugeicons/core-free-icons";
import type { LinkedEnd } from "./SidebarLinks";
import { formatLineCount, type ChatMark } from "@/lib/chat-list";
import type { DiffStat, PullRequest } from "@/model";
import { activityAgo } from "@milagre/shared/chat-row";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { chatMarkTone, markToneClass, markLabel, MARK_ICON, MarkIcon } from "./ChatMarks";
import { LinearIssueChip, PullRequestChip } from "./ChatRowChips";
import type { RowComputer, SidebarRecent } from "./ChatRow";
import { computerIcon, ROW_PR_LIMIT } from "./chat-row-parts";

const INBOX_STATUS: Record<Exclude<ChatMark, "idle" | "unread">, string> = {
  interrupted: "Interrupted",
  question: "Needs reply",
  waiting: "Needs approval",
  delegated: "On a Delegation",
  running: "Running",
  background: "In the background",
};

function inboxStatus(item: SidebarRecent): { label: string; tone: string } | null {
  const mark = item.mark ?? "idle";
  if (mark === "idle") return item.details?.failed ? { label: "Failed", tone: "text-red-ink" } : null;
  if (mark === "unread") return null;
  return { label: INBOX_STATUS[mark], tone: markToneClass[chatMarkTone(mark)] };
}

export function RowProjectIcon({
  image,
  initial = "",
  chats = false,
  small = false,
}: {
  image?: string | null;
  initial?: string;
  chats?: boolean;
  small?: boolean;
}) {
  const letter = initial.trim().slice(0, 1).toUpperCase() || "P";
  if (small && chats)
    return (
      <span aria-hidden data-chat-project-icon className="flex shrink-0 text-ink-4">
        <HugeiconsIcon icon={BubbleChatIcon} size={14} strokeWidth={1.8} color="currentColor" />
      </span>
    );
  return (
    <span
      aria-hidden
      data-chat-project-icon
      className={`sidebar-copy flex shrink-0 items-center justify-center overflow-hidden bg-ink text-10 font-semibold text-on-ink ${small ? "size-3.5 rounded-inline" : "size-5 rounded-chip"}`}
    >
      {chats ? <HugeiconsIcon icon={BubbleChatIcon} size={12} /> : <WorkspaceIcon src={image} fallback={letter} />}
    </span>
  );
}

const ROW_STYLES = {
  inbox: {
    markSize: 14,
    ago: "text-[length:calc(12px+var(--sidebar-delta))] leading-4",
    agoUnread: "font-medium text-ink",
    unreadDot: "size-2 rounded-full bg-accent",
    column: "sidebar-copy flex min-w-0 flex-col",
    row: "flex h-5 min-w-0 items-center gap-1.5",
    open: { snoozable: "pr-[78px]", plain: "pr-[56px]" },
    hover: { snoozable: "group-focus-within/row:pr-[78px] group-hover/row:pr-[78px]", plain: "group-focus-within/row:pr-[56px] group-hover/row:pr-[56px]" },
    pin: "flex shrink-0 text-ink-4",
    pinStroke: 1.8,
    time: "ml-auto flex shrink-0 items-center gap-1.5 pl-2 transition-opacity duration-100",
  },
  classic: {
    markSize: undefined,
    ago: "text-[length:calc(11.5px+var(--sidebar-delta))]",
    agoUnread: "font-semibold text-accent",
    unreadDot: "mx-1 size-2 rounded-full bg-accent",
    column: "sidebar-copy flex min-w-0 flex-1 flex-col",
    row: "flex h-[18px] min-w-0 items-center gap-1.5",
    open: { snoozable: "pr-[70px]", plain: "pr-[48px]" },
    hover: { snoozable: "group-focus-within/row:pr-[70px] group-hover/row:pr-[70px]", plain: "group-focus-within/row:pr-[48px] group-hover/row:pr-[48px]" },
    pin: "flex shrink-0 text-ink-3",
    pinStroke: 2,
    time: "ml-auto flex shrink-0 items-center gap-1.5 pl-1 transition-opacity duration-100",
  },
} as const;

type RowStyle = keyof typeof ROW_STYLES;

function InboxMark({ item, lastAt, now, variant }: { item: SidebarRecent; lastAt?: number; now: number; variant: RowStyle }) {
  const styles = ROW_STYLES[variant];
  const mark = item.mark ?? "idle";
  const label = mark === "idle" || mark === "unread" ? "" : markLabel(mark, item.background);
  if (mark === "running" || mark === "background")
    return (
      <span data-slot="chat-mark" data-mark={mark} role="img" aria-label={label} title={label} className="flex w-4 justify-center">
        <SpinnerRing size={12} />
      </span>
    );
  if (mark in MARK_ICON)
    return (
      <span data-slot="chat-mark" data-mark={mark} role="img" aria-label={label} title={label} className="flex w-4 justify-center">
        <MarkIcon mark={mark as keyof typeof MARK_ICON} size={styles.markSize} />
      </span>
    );
  return (
    <>
      {lastAt !== undefined && (
        <span data-chat-ago title={new Date(lastAt).toLocaleString()} className={`${styles.ago} tabular-nums ${item.unread ? styles.agoUnread : "text-ink-3"}`}>
          {activityAgo(lastAt, now)}
        </span>
      )}
      {item.unread && <span data-slot="chat-mark" data-mark="unread" role="img" aria-label="Unread" title="Unread" className={styles.unreadDot} />}
      {!item.unread &&
        item.details?.failed &&
        (variant === "inbox" ? (
          <span data-slot="chat-mark" data-mark="failed" role="img" aria-label="Failed" title="Failed" className="flex text-red">
            <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.8} color="currentColor" />
          </span>
        ) : (
          <span data-slot="chat-mark" data-mark="failed" role="img" aria-label="Failed" className="mx-1 size-2 rounded-full bg-red" />
        ))}
    </>
  );
}

function hasInboxMark(item: SidebarRecent, lastAt?: number) {
  return (item.mark ?? "idle") !== "idle" || lastAt !== undefined || Boolean(item.unread) || Boolean(item.details?.failed);
}

function titleClass(variant: RowStyle, item: SidebarRecent) {
  if (variant === "classic")
    return `min-w-0 truncate text-[length:calc(13px+var(--sidebar-delta))] leading-[18px] text-ink ${item.unread ? "font-semibold" : "font-medium"}`;
  const quiet = (item.mark ?? "idle") === "idle" && !item.unread && !item.details?.failed;
  return `min-w-0 truncate text-[length:calc(14px+var(--sidebar-delta))] leading-5 font-medium ${quiet ? "text-ink-2" : "text-ink"}`;
}

export function InboxTitleLine({
  item,
  linked,
  lastAt,
  now,
  hideTime,
  doneable,
  snoozable = false,
  menuOpen = false,
  variant = "inbox",
}: {
  item: SidebarRecent;
  linked: LinkedEnd[];
  lastAt?: number;
  now: number;
  hideTime: boolean;
  doneable: boolean;
  snoozable?: boolean;
  menuOpen?: boolean;
  variant?: RowStyle;
}) {
  const styles = ROW_STYLES[variant];
  const status = inboxStatus(item);
  const clearance = snoozable ? "snoozable" : "plain";
  return (
    <span className={styles.column}>
      <span className={`${styles.row} ${doneable && menuOpen ? styles.open[clearance] : doneable && !hideTime ? styles.hover[clearance] : ""}`}>
        {item.pinned && (
          <span data-chat-pinned role="img" aria-label="Pinned" className={styles.pin}>
            <HugeiconsIcon icon={PinIcon} size={12} strokeWidth={styles.pinStroke} color="currentColor" />
          </span>
        )}
        <span className={titleClass(variant, item)}>
          <ChatTitle label={item.label} />
        </span>
        {linked.length > 0 && (
          <span
            data-chat-linked
            role="img"
            aria-label={`Linked to ${linked.map((end) => end.label).join(", ")}`}
            title={`Linked to ${linked.map((end) => end.label).join(", ")}`}
            className="flex shrink-0 text-ink-3"
          >
            <HugeiconsIcon icon={Link04Icon} size={12} strokeWidth={2} color="currentColor" />
          </span>
        )}
        {item.heartbeat && (
          <span data-chat-heartbeat role="img" aria-label={item.heartbeat} title="Heartbeat" className="flex shrink-0 text-ink-3">
            <HugeiconsIcon icon={Pulse01Icon} size={12} strokeWidth={2} color="currentColor" />
          </span>
        )}
        {hasInboxMark(item, lastAt) && (
          <span data-chat-time className={`${styles.time} ${hideTime ? "opacity-0" : doneable ? "group-focus-within/row:hidden group-hover/row:hidden" : ""}`}>
            <InboxMark item={item} lastAt={lastAt} now={now} variant={variant} />
          </span>
        )}
      </span>
      {(status || item.unread) && <span className="sr-only">{[status?.label, item.unread ? "Unread" : ""].filter(Boolean).join(", ")}</span>}
    </span>
  );
}

function DiffStatText({ diff }: { diff: DiffStat }) {
  return (
    <span data-chat-diff className="shrink-0 tabular-nums">
      <span className="text-diff-add">+{formatLineCount(diff.added)}</span> <span className="text-diff-remove">−{formatLineCount(diff.removed)}</span>
    </span>
  );
}

export function InboxLine({
  item,
  project,
  projectImage,
  projectInitial,
  projectChats = false,
  linkProjects,
  pullRequests,
  linearIssue,
  diff,
  computer,
  archiving,
  active,
  waiting = 0,
  subchat = false,
  depth = 1,
  family,
}: {
  item: SidebarRecent;
  project: string;
  projectImage?: string | null;
  projectInitial?: string;
  projectChats?: boolean;
  linkProjects?: number;
  pullRequests: PullRequest[];
  linearIssue?: LinearIssue;
  diff?: DiffStat;
  computer?: RowComputer;
  archiving: boolean;
  active: boolean;
  waiting?: number;
  subchat?: boolean;
  depth?: number;
  family?: { count: number; folded: boolean; asking?: boolean; onToggle: () => void };
}) {
  const extra = (key: string, node: ReactNode) => (
    <Fragment key={key}>
      <span aria-hidden className="shrink-0 text-ink-4">
        ·
      </span>
      {node}
    </Fragment>
  );
  return (
    <div
      data-chat-prs
      data-chat-line
      className={`sidebar-copy pointer-events-none absolute ${subchat ? (depth > 1 ? "left-[52px]" : "left-9") : "left-5"} right-5 top-[30px] z-20 flex h-4 min-w-0 items-center gap-2 text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-3 ${archiving ? "opacity-30" : ""}`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {linkProjects !== undefined && item.worktreeCount !== undefined ? (
          <span data-chat-project data-chat-link-projects className="flex min-w-0 shrink items-center gap-1.5">
            <HugeiconsIcon icon={Link04Icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-4" />
            <span className="truncate">{linkProjects === 1 ? "1 Project" : `${linkProjects} Projects`}</span>
          </span>
        ) : (
          <span className="flex min-w-0 shrink items-center gap-1.5">
            <RowProjectIcon image={projectImage} initial={projectInitial ?? project} chats={projectChats} small />
            <span data-chat-project className="truncate">
              {project}
            </span>
          </span>
        )}
        {family && <FamilyBadge item={item} family={family} archiving={archiving} />}
        {linearIssue && extra("linear", <LinearIssueChip issue={linearIssue} inbox />)}
        {diff && extra("diff", <DiffStatText diff={diff} />)}
        {computer && (
          <span
            data-chat-computer
            className={`ml-0.5 flex min-w-0 shrink items-center gap-1 ${computer.offline ? "text-orange-ink" : active ? "text-ink-2" : "transition-colors group-hover/row:text-ink-2"}`}
          >
            <HugeiconsIcon icon={computerIcon(computer)} size={12} strokeWidth={1.8} color="currentColor" className="shrink-0" />
            <span className="truncate">{computer.offline ? `${computer.name}, offline` : computer.name}</span>
          </span>
        )}
        {waiting > 0 &&
          extra(
            "waiting",
            <span data-chat-waiting className="shrink-0 text-orange-ink">
              {waiting} waiting
            </span>,
          )}
      </span>
      {pullRequests.length > 0 && <PullRequestChip pr={pullRequests[0]!} item={item} labelled={false} inbox edge count={pullRequests.length} />}
    </div>
  );
}

export function FamilyBadge({
  item,
  family,
  archiving,
  className = "",
}: {
  item: SidebarRecent;
  family: { count: number; folded: boolean; asking?: boolean; onToggle: () => void };
  archiving: boolean;
  className?: string;
}) {
  const fill = family.asking ? "var(--orange)" : family.folded ? "var(--line-strong)" : "var(--accent-tint)";
  return (
    <button
      type="button"
      data-subchat-toggle
      data-subchat-badge
      data-asking={family.asking || undefined}
      aria-expanded={!family.folded}
      aria-label={`${family.folded ? "Show" : "Hide"} ${family.count} subchat${family.count === 1 ? "" : "s"} of ${item.label}${family.asking ? ", one needs you" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        family.onToggle();
      }}
      style={{ backgroundImage: `linear-gradient(${fill}, ${fill})` }}
      className={`sidebar-copy pointer-events-auto ${className.includes("absolute") ? "" : "relative"} flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface px-1 text-10 font-semibold tabular-nums transition-colors before:absolute before:-inset-1 focus-visible:outline-2 ${
        family.asking ? "text-black" : family.folded ? "text-ink" : "text-accent-ink"
      } ${archiving ? "opacity-30" : ""} ${className}`}
    >
      {family.count}
    </button>
  );
}

export function ClassicInboxLine({
  item,
  project,
  linkProjects,
  pullRequests,
  linearIssue,
  diff,
  computer,
  archiving,
  waiting = 0,
  subchat = false,
  depth = 1,
}: {
  item: SidebarRecent;
  project: string;
  linkProjects?: number;
  pullRequests: PullRequest[];
  linearIssue?: LinearIssue;
  diff?: DiffStat;
  computer?: RowComputer;
  archiving: boolean;
  waiting?: number;
  subchat?: boolean;
  depth?: number;
}) {
  const shown = pullRequests.slice(0, ROW_PR_LIMIT);
  const hidden = pullRequests.length - shown.length;
  const parts: Array<{ key: string; node: ReactNode; shrink?: boolean }> = [];
  parts.push({
    key: "project",
    shrink: true,
    node:
      linkProjects !== undefined && item.worktreeCount !== undefined ? (
        <span data-chat-project data-chat-link-projects className="flex min-w-0 items-center gap-1">
          <HugeiconsIcon icon={Link04Icon} size={12} strokeWidth={2} color="currentColor" className="shrink-0 text-ink-3" />
          <span className="truncate">{linkProjects === 1 ? "1 Project" : `${linkProjects} Projects`}</span>
        </span>
      ) : (
        <span data-chat-project className="truncate">
          {project}
        </span>
      ),
  });
  if (linearIssue)
    parts.push({
      key: "linear",
      node: <LinearIssueChip issue={linearIssue} inbox />,
    });
  shown.forEach((pr) =>
    parts.push({
      key: pr.url,
      node: <PullRequestChip pr={pr} item={item} labelled={false} inbox />,
    }),
  );
  if (hidden > 0)
    parts.push({
      key: "pr-more",
      node: (
        <span data-chat-pr-more aria-label={`${hidden} more pull request${hidden === 1 ? "" : "s"}`} className="shrink-0 tabular-nums text-ink-3">
          +{hidden}
        </span>
      ),
    });
  if (diff)
    parts.push({
      key: "diff",
      node: <DiffStatText diff={diff} />,
    });
  if (computer)
    parts.push({
      key: "computer",
      shrink: true,
      node: (
        <span data-chat-computer className={`flex min-w-0 items-center gap-1 ${computer.offline ? "text-orange-ink" : ""}`}>
          <HugeiconsIcon
            icon={computerIcon(computer)}
            size={12}
            strokeWidth={2}
            color="currentColor"
            className={`shrink-0 ${computer.offline ? "" : "text-ink-3"}`}
          />
          <span className="truncate">{computer.offline ? `${computer.name}, offline` : computer.name}</span>
        </span>
      ),
    });
  if (waiting > 0)
    parts.push({
      key: "waiting",
      node: (
        <span data-chat-waiting className="shrink-0 text-orange-ink">
          {waiting} waiting
        </span>
      ),
    });
  return (
    <div
      data-chat-prs
      data-chat-line
      className={`sidebar-copy pointer-events-none absolute ${subchat ? (depth > 1 ? "left-[76px]" : "left-[60px]") : "left-[44px]"} right-4 top-[27px] z-20 flex h-4 min-w-0 items-center overflow-hidden text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-2 ${archiving ? "opacity-30" : ""}`}
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && (
            <span aria-hidden className="shrink-0 px-1 text-ink-3">
              ·
            </span>
          )}
          {part.shrink ? <span className="flex min-w-0 shrink items-center">{part.node}</span> : part.node}
        </Fragment>
      ))}
    </div>
  );
}
