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

/* ─────────────────────────────────────────────────────────
 * INBOX ROW
 * The One list's row, design "Alt A, status on the edge, title
 * first" (gpui-sidebar-v-a v3), 54px: the title with the chat's
 * state at its right edge (a spinner while it runs, the question or
 * approval icon, a failure's alert, else the time with the unread
 * dot), then one line with the Project's 14px tile and name, its
 * Linear issue, the diff and the computer, and the pull request at
 * the right edge. Its menu opens on a right-click.
 * ───────────────────────────────────────────────────────── */
/** What an inbox row's second line says the chat is doing, in its mark's color. Unread says it with the dot instead. */
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
  // The inbox row's second line wears a 14px tile; a Chat without a Project there is the Chats bubble alone.
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
      {/* A Chat without a Project wears the Chats group's bubble, as its header does in the grouped sidebar. */}
      {chats ? <HugeiconsIcon icon={BubbleChatIcon} size={12} /> : <WorkspaceIcon src={image} fallback={letter} />}
    </span>
  );
}

/**
 * The one state at the right edge of line one: a spinner while the chat works, the question or approval icon while it
 * waits on you, a red alert after a failed turn, else the time, brighter while unread, with the unread dot. Line two says
 * no state, only what the chat is.
 */
function InboxMark({ item, lastAt, now }: { item: SidebarRecent; lastAt?: number; now: number }) {
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
        <MarkIcon mark={mark as keyof typeof MARK_ICON} size={14} />
      </span>
    );
  return (
    <>
      {lastAt !== undefined && (
        <span
          data-chat-ago
          title={new Date(lastAt).toLocaleString()}
          className={`text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums ${item.unread ? "font-medium text-ink" : "text-ink-3"}`}
        >
          {activityAgo(lastAt, now)}
        </span>
      )}
      {item.unread && <span data-slot="chat-mark" data-mark="unread" role="img" aria-label="Unread" title="Unread" className="size-2 rounded-full bg-accent" />}
      {!item.unread && item.details?.failed && (
        <span data-slot="chat-mark" data-mark="failed" role="img" aria-label="Failed" title="Failed" className="flex text-red">
          <HugeiconsIcon icon={AlertCircleIcon} size={14} strokeWidth={1.8} color="currentColor" />
        </span>
      )}
    </>
  );
}

/** Whether InboxMark draws anything: a mark, the time, the unread dot or a failed dot. */
function hasInboxMark(item: SidebarRecent, lastAt?: number) {
  return (item.mark ?? "idle") !== "idle" || lastAt !== undefined || Boolean(item.unread) || Boolean(item.details?.failed);
}

/** Line one: pin, title, Link and heartbeat icons, then the chat's one mark (InboxMark). */
export function InboxTitleLine({
  item,
  linked,
  lastAt,
  now,
  hideTime,
  doneable,
  snoozable = false,
  menuOpen = false,
}: {
  item: SidebarRecent;
  linked: LinkedEnd[];
  lastAt?: number;
  now: number;
  /** The ⌘1–9 hint or the open menu sits where the time goes. */
  hideTime: boolean;
  /** The hover "Done" button takes the mark's place while the pointer is on the row. */
  doneable: boolean;
  /** The hover Snooze (or Wake) icon sits left of Done, so the title stops further in. */
  snoozable?: boolean;
  /** The row's menu is open: its hover icons stay shown, so the title keeps clear of them. */
  menuOpen?: boolean;
}) {
  const status = inboxStatus(item);
  // A read Chat with nothing going on steps back to ink-2; one that is unread, working, waiting or failed stays ink.
  const quiet = (item.mark ?? "idle") === "idle" && !item.unread && !item.details?.failed;
  return (
    <span className="sidebar-copy flex min-w-0 flex-col">
      {/* The hover "Done" button sits over the state's place: the title stops before it instead of running under it. */}
      <span
        className={`flex h-5 min-w-0 items-center gap-1.5 ${doneable && menuOpen ? (snoozable ? "pr-[78px]" : "pr-[56px]") : doneable && !hideTime ? (snoozable ? "group-focus-within/row:pr-[78px] group-hover/row:pr-[78px]" : "group-focus-within/row:pr-[56px] group-hover/row:pr-[56px]") : ""}`}
      >
        {item.pinned && (
          <span data-chat-pinned role="img" aria-label="Pinned" className="flex shrink-0 text-ink-4">
            <HugeiconsIcon icon={PinIcon} size={12} strokeWidth={1.8} color="currentColor" />
          </span>
        )}
        <span className={`min-w-0 truncate text-[length:calc(14px+var(--sidebar-delta))] leading-5 font-medium ${quiet ? "text-ink-2" : "text-ink"}`}>
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
        {/* The slot is there only when it has something to show, so a quiet row's title runs to the row's end. */}
        {hasInboxMark(item, lastAt) && (
          <span
            data-chat-time
            className={`ml-auto flex shrink-0 items-center gap-1.5 pl-2 transition-opacity duration-100 ${hideTime ? "opacity-0" : doneable ? "group-focus-within/row:hidden group-hover/row:hidden" : ""}`}
          >
            <InboxMark item={item} lastAt={lastAt} now={now} />
          </span>
        )}
      </span>
      {/* Read with the row's name; the second line beside it is outside the button and shown, not read. */}
      {(status || item.unread) && <span className="sr-only">{[status?.label, item.unread ? "Unread" : ""].filter(Boolean).join(", ")}</span>}
    </span>
  );
}

/**
 * Line two, over the row's button: the Project's 14px tile and name (or a Link Chat's Projects), a parent's subchat count,
 * the Linear issue, the diff, the computer and what waits for it, then the pull request at the right edge. Only the count,
 * the issue and the pull request take the pointer; the rest lets a click through to the row.
 */
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
  /** The row is the open one: the computer reads as on a hovered row. */
  active: boolean;
  /** Messages waiting on this Mac for the chat's offline computer. */
  waiting?: number;
  /** The row is indented as a subchat. */
  subchat?: boolean;
  /** How far in: 1 under the parent, 2 under a subchat (the sidebar goes no deeper). */
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
        {diff &&
          extra(
            "diff",
            <span data-chat-diff className="shrink-0 tabular-nums">
              <span className="text-diff-add">+{formatLineCount(diff.added)}</span> <span className="text-diff-remove">−{formatLineCount(diff.removed)}</span>
            </span>,
          )}
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

/**
 * A parent's subchat count, which folds and unfolds them: on the Project icon in the grouped lists, on line two after the
 * Project in the inbox row. Orange while one of them waits on you.
 */
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

/* The Classic inbox row (Settings › Appearance › Sidebar rows): the Project's icon, then the title with its time, then one
 * dotted line naming the Project, its Linear issue and pull requests, the diff and the computer. */
/**
 * The one mark at the end of line one: a spinner while the chat works, the question or approval icon while it waits on
 * you, a red dot after a failed turn, else the time with the unread dot. Line two says no state, only what the chat is.
 */
function ClassicInboxMark({ item, lastAt, now }: { item: SidebarRecent; lastAt?: number; now: number }) {
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
        <MarkIcon mark={mark as keyof typeof MARK_ICON} />
      </span>
    );
  return (
    <>
      {lastAt !== undefined && (
        <span
          data-chat-ago
          title={new Date(lastAt).toLocaleString()}
          className={`text-[length:calc(11.5px+var(--sidebar-delta))] tabular-nums ${item.unread ? "font-semibold text-accent" : "text-ink-3"}`}
        >
          {activityAgo(lastAt, now)}
        </span>
      )}
      {item.unread && (
        <span data-slot="chat-mark" data-mark="unread" role="img" aria-label="Unread" title="Unread" className="mx-1 size-2 rounded-full bg-accent" />
      )}
      {!item.unread && item.details?.failed && (
        <span data-slot="chat-mark" data-mark="failed" role="img" aria-label="Failed" className="mx-1 size-2 rounded-full bg-red" />
      )}
    </>
  );
}

/** Line one: pin, title, Link and heartbeat icons, then the chat's one mark (InboxMark). */
export function ClassicInboxTitleLine({
  item,
  linked,
  lastAt,
  now,
  hideTime,
  doneable,
  snoozable = false,
  menuOpen = false,
}: {
  item: SidebarRecent;
  linked: LinkedEnd[];
  lastAt?: number;
  now: number;
  /** The ⌘1–9 hint or the open menu sits where the time goes. */
  hideTime: boolean;
  /** The hover "Done" button takes the mark's place while the pointer is on the row. */
  doneable: boolean;
  /** The hover Snooze (or Wake) icon sits left of Done, so the title stops further in. */
  snoozable?: boolean;
  /** The row's menu is open: its hover icons stay shown, so the title keeps clear of them. */
  menuOpen?: boolean;
}) {
  const status = inboxStatus(item);
  return (
    <span className="sidebar-copy flex min-w-0 flex-1 flex-col">
      {/* The hover "Done" button sits over the mark's place: the title stops before it instead of running under it. */}
      <span
        className={`flex h-[18px] min-w-0 items-center gap-1.5 ${doneable && menuOpen ? (snoozable ? "pr-[70px]" : "pr-[48px]") : doneable && !hideTime ? (snoozable ? "group-focus-within/row:pr-[70px] group-hover/row:pr-[70px]" : "group-focus-within/row:pr-[48px] group-hover/row:pr-[48px]") : ""}`}
      >
        {item.pinned && (
          <span data-chat-pinned role="img" aria-label="Pinned" className="flex shrink-0 text-ink-3">
            <HugeiconsIcon icon={PinIcon} size={12} strokeWidth={2} color="currentColor" />
          </span>
        )}
        <span
          className={`min-w-0 truncate text-[length:calc(13px+var(--sidebar-delta))] leading-[18px] text-ink ${item.unread ? "font-semibold" : "font-medium"}`}
        >
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
        {/* The slot is there only when it has something to show, so a quiet row's title runs to the row's end. */}
        {hasInboxMark(item, lastAt) && (
          <span
            data-chat-time
            className={`ml-auto flex shrink-0 items-center gap-1.5 pl-1 transition-opacity duration-100 ${hideTime ? "opacity-0" : doneable ? "group-focus-within/row:hidden group-hover/row:hidden" : ""}`}
          >
            <ClassicInboxMark item={item} lastAt={lastAt} now={now} />
          </span>
        )}
      </span>
      {/* Read with the row's name; the second line beside it is outside the button and shown, not read. */}
      {(status || item.unread) && <span className="sr-only">{[status?.label, item.unread ? "Unread" : ""].filter(Boolean).join(", ")}</span>}
    </span>
  );
}

/**
 * Line two, over the row's button: Project (or a Link Chat's Projects) · Linear issue · pull requests · status · diff ·
 * computer. Only the issue and pull request links take the pointer; the rest lets a click through to the row.
 */
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
  /** Messages waiting on this Mac for the chat's offline computer. */
  waiting?: number;
  /** The row is indented as a subchat. */
  subchat?: boolean;
  /** How far in: 1 under the parent, 2 under a subchat (the sidebar goes no deeper). */
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
      node: (
        <span data-chat-diff className="shrink-0 tabular-nums">
          <span className="text-diff-add">+{formatLineCount(diff.added)}</span> <span className="text-diff-remove">−{formatLineCount(diff.removed)}</span>
        </span>
      ),
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
