import { linkChatWorktreesLabel } from "@milagre/shared/worktree-link";
import { ChatTitle } from "./ChatTitle";
import { type LinearIssue } from "@milagre/shared/linear";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Fragment, memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  Folder01Icon,
  GitBranchIcon,
  Link04Icon,
  MoreVerticalIcon,
  Pulse01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { LinkedEnd } from "./SidebarLinks";
import Tooltip from "@/components/primitives/Tooltip";
import { ShortcutKeys } from "@/components/primitives/ShortcutKeys";
import { type ArchiveMode, type ArchivePlan } from "@/lib/archive";
import { formatLineCount, type ChatMark } from "@/lib/chat-list";
import { rowPullRequests } from "@/lib/chat-pull-requests";
import type { AgentPort, DiffStat, PullRequest } from "@/model";
import { activityAgo, DESKTOP_CHAT_ROW_SHOW, type ChatRowShow } from "@milagre/shared/chat-row";
import { useDisplayNow } from "../../lib/display-clock";
import { useOutboxWaiting } from "../../lib/outbox";
import { useSettings } from "../../lib/settings";
import { snoozeDurationLabel } from "@milagre/shared/snooze";
import { HugeIcon, ChatMarkDot, railDotTone } from "./ChatMarks";
import { LinearIssueChip, PullRequestChip } from "./ChatRowChips";
import { RowProjectIcon, InboxTitleLine, InboxLine, FamilyBadge, ClassicInboxLine } from "./InboxLines";
import { RenameField } from "./RenameField";
import { ChatHoverCard } from "./ChatHoverCard";
import { LinkIssuePopover, ChatMenu } from "./ChatRowMenus";
import { computerIcon, ROW_PR_LIMIT, MENU_WIDTH } from "./chat-row-parts";
export { PullRequestOpenContext } from "./ChatRowChips";

function useMinute(on: boolean) {
  const now = useDisplayNow(30_000, on);
  return on ? now : 0;
}

type ChatDetails = {
  branch?: string;
  path?: string;
  diff?: DiffStat;
  pullRequests?: PullRequest[];
  linearIssue?: LinearIssue;
  linearKey?: string;
  linkable?: boolean;
  failed?: boolean;
  ports?: AgentPort[];
  lastAt?: number;
  firstAt?: number;
};

export type RowComputer = { name: string; offline: boolean; local?: boolean };

export type SidebarRecent = {
  id: string;
  pending?: boolean;
  label: string;
  worktreeCount?: number;
  prompt?: string;
  mark?: ChatMark;
  background?: number;
  unread?: boolean;
  pinned?: boolean;
  pinOrder?: number;
  doneAt?: number;
  snoozedUntil?: number;
  parent?: string;
  heartbeat?: string;
  details?: ChatDetails;
};

export type ChatRowActions = {
  onRename?: (id: string, title: string) => void;
  onMarkUnread?: (id: string, unread: boolean) => void;
  onReload?: (id: string) => void;
  onReportBug?: (id: string) => void;
  onPin?: (id: string, order?: number | null) => void;
  onDone?: (id: string) => void;
  onReopen?: (id: string) => void;
  onSnooze?: (id: string, until: number) => void;
  onWake?: (id: string) => void;
  onReveal?: (id: string) => void;
  onOpenInEditor?: (id: string) => void;
  remote?: boolean;
  onCommit?: (id: string) => void;
  gitless?: boolean;
  onArchiveCheck?: (id: string) => Promise<ArchivePlan>;
  onArchive?: (id: string, mode: ArchiveMode, plan: ArchivePlan) => Promise<unknown> | void;
  onUndoArchive?: (id: string) => boolean;
  onLinkIssue?: (id: string, key: string, workspace?: string) => void;
  onUnlinkIssue?: (id: string) => void;
  onLinkWith?: (id: string, anchor: { top: number; left: number }) => void;
  onRemoveLink?: (id: string, anchor: { top: number; left: number }) => void;
  onDetach?: (id: string) => void;
};

const NO_LINKS: LinkedEnd[] = [];

const HOVER_CARD_DELAY = 500;
const PREFETCH_DELAY = 90;
const HOVER_CARD_GRACE = 250;
const snoozeEnd = (minutes: number) => Date.now() + minutes * 60_000;

function recentInitials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

let hoveredDone: (() => void) | null = null;
let doneKeyListening = false;
const isDoneKey = (event: KeyboardEvent | ReactKeyboardEvent) =>
  event.key.toLowerCase() === "e" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat;
function listenForDoneKey() {
  if (doneKeyListening) return;
  doneKeyListening = true;
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !hoveredDone || !isDoneKey(event)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    hoveredDone();
  });
}

export const ChatRow = memo(function ChatRow({
  item,
  active,
  collapsed,
  onPick,
  onHover,
  actions,
  shortcutHint,
  computer,
  show = DESKTOP_CHAT_ROW_SHOW,
  dimOffline = false,
  dragging = false,
  linked = NO_LINKS,
  project,
  projectImage,
  projectInitial,
  projectChats = false,
  linkProjects,
  chatKey,
  subchat = false,
  depth = 1,
  family,
}: {
  item: SidebarRecent;
  active: boolean;
  collapsed: boolean;
  onPick: (item: SidebarRecent) => void;
  onHover?: (item: SidebarRecent) => void;
  actions: ChatRowActions;
  shortcutHint?: string;
  computer?: RowComputer;
  show?: ChatRowShow;
  dimOffline?: boolean;
  dragging?: boolean;
  linked?: LinkedEnd[];
  project?: string;
  projectImage?: string | null;
  projectInitial?: string;
  projectChats?: boolean;
  linkProjects?: number;
  chatKey?: string;
  subchat?: boolean;
  depth?: number;
  family?: {
    count: number;
    folded: boolean;
    asking?: boolean;
    onToggle: () => void;
  };
}) {
  const [archiving, setArchiving] = useState(false);
  const archivePending = useRef(false);
  const mark = item.mark ?? "idle";
  const pullRequests = !collapsed && show.pullRequests ? rowPullRequests(item.details?.pullRequests ?? []) : [];
  const linearIssue = !collapsed && show.linearIssue ? item.details?.linearIssue : undefined;
  const hasPullRequests = pullRequests.length > 0;
  const hasChips = hasPullRequests || linearIssue !== undefined;
  const shownPullRequests = pullRequests.slice(0, ROW_PR_LIMIT);
  const hiddenPullRequests = pullRequests.length - shownPullRequests.length;
  const rowComputer = show.computer ? computer : undefined;
  const branch = show.branch ? item.details?.branch : undefined;
  const diff = show.diff && item.details?.diff && (item.details.diff.added > 0 || item.details.diff.removed > 0) ? item.details.diff : undefined;
  const lastAt = show.lastActivity ? item.details?.lastAt : undefined;
  const now = useMinute(lastAt !== undefined);
  const waiting = useOutboxWaiting(chatKey ?? "");
  const facts: ReactNode[] = [];
  if (rowComputer)
    facts.push(
      <span key="computer" data-chat-computer className="flex min-w-0 shrink items-center gap-1 truncate">
        <HugeiconsIcon icon={computerIcon(rowComputer)} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
        {rowComputer.offline ? `${rowComputer.name}, offline` : rowComputer.name}
      </span>,
    );
  if (waiting > 0 && !collapsed)
    facts.push(
      <span key="waiting" data-chat-waiting className="shrink-0 text-orange-ink">
        {waiting} waiting
      </span>,
    );
  const projectName = collapsed ? undefined : project;
  const inbox = projectName !== undefined;
  const {
    appearance: { sidebarRows: rowStyle },
    snoozeMinutes,
  } = useSettings();
  const edge = inbox && rowStyle === "edge";
  const shownFamily = collapsed ? undefined : family;
  const factLine = Boolean(projectName) || facts.length > 0 || Boolean(branch || diff || lastAt !== undefined) || hasChips;
  if (item.worktreeCount !== undefined && factLine)
    facts.push(
      <span key="worktrees" className="shrink-0">
        {linkChatWorktreesLabel(item.worktreeCount)}
      </span>,
    );
  if (branch)
    facts.push(
      <span key="branch" data-chat-branch className="flex min-w-0 shrink items-center gap-1 truncate">
        <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
        <span className="truncate">{branch}</span>
      </span>,
    );
  if (diff)
    facts.push(
      <span key="diff" data-chat-diff className="shrink-0 font-mono text-[length:calc(11px+var(--sidebar-delta))] tabular-nums">
        <span className="text-diff-add">+{formatLineCount(diff.added)}</span> <span className="text-diff-remove">−{formatLineCount(diff.removed)}</span>
      </span>,
    );
  if (lastAt !== undefined)
    facts.push(
      <span key="ago" data-chat-ago title={new Date(lastAt).toLocaleString()} className="shrink-0 tabular-nums">
        {activityAgo(lastAt, now)}
      </span>,
    );
  if (projectName)
    facts.unshift(
      <span key="project" data-chat-project className="flex min-w-0 shrink items-center gap-1 truncate">
        <HugeiconsIcon icon={Folder01Icon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
        <span className="truncate">{projectName}</span>
      </span>,
    );
  const twoLines = factLine || item.worktreeCount !== undefined || Boolean(shownFamily);
  const prLines = factLine;
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [card, setCard] = useState<{
    top: number;
    left: number;
    flip: boolean;
  } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linking, setLinking] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const doneable = Boolean(actions.onDone) && !item.pending && !collapsed && !item.doneAt;
  const markDone = () => {
    if (!doneable || archivePending.current) return;
    hideCard();
    actions.onDone?.(item.id);
  };
  const snoozed = Boolean(item.snoozedUntil);
  const snoozable = doneable && Boolean(snoozed ? actions.onWake : actions.onSnooze);
  const snoozeLabel = snoozed ? "Wake" : `Snooze for ${snoozeDurationLabel(snoozeMinutes)}`;
  const snoozeNow = () => {
    if (!snoozable || archivePending.current) return;
    hideCard();
    if (snoozed) actions.onWake?.(item.id);
    else actions.onSnooze?.(item.id, snoozeEnd(snoozeMinutes));
  };
  const markDoneRef = useRef(markDone);
  markDoneRef.current = markDone;
  const ownDone = useRef(() => markDoneRef.current());
  useEffect(() => {
    if (doneable) listenForDoneKey();
    return () => {
      if (hoveredDone === ownDone.current) hoveredDone = null;
    };
  }, [doneable]);

  const clearHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const hideCard = () => {
    clearHover();
    setCard(null);
  };
  const prefetchTimer = useRef<number | null>(null);
  const clearPrefetch = () => {
    if (prefetchTimer.current !== null) window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  };
  const prefetchSoon = () => {
    clearPrefetch();
    if (!onHover) return;
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      onHover(item);
    }, PREFETCH_DELAY);
  };
  const showCardSoon = () => {
    clearHover();
    prefetchSoon();
    if (menu || renaming || card || document.documentElement.hasAttribute("data-chat-drag")) return;
    hoverTimer.current = window.setTimeout(() => {
      const row = rowRef.current;
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const sidebar = row.closest("aside")?.getBoundingClientRect() ?? rect;
      const flip = rect.top > window.innerHeight - 240;
      setCard({
        top: flip ? window.innerHeight - rect.bottom - 4 : rect.top - 4,
        left: sidebar.right + 8,
        flip,
      });
    }, HOVER_CARD_DELAY);
  };

  const hideCardSoon = () => {
    clearHover();
    if (card) hoverTimer.current = window.setTimeout(() => setCard(null), HOVER_CARD_GRACE);
  };

  useEffect(() => clearHover, []);

  const openMenu = (x: number, y: number) => {
    if (item.pending || archivePending.current) return;
    hideCard();
    setMenu({ x: Math.min(x, window.innerWidth - MENU_WIDTH - 8), y });
  };

  return (
    <>
      <div
        ref={rowRef}
        data-chat-id={item.id}
        data-subchat={subchat && !collapsed ? "" : undefined}
        className={`group/row relative ${edge ? "pb-px" : ""} ${subchat && !collapsed ? (depth > 1 ? "pl-8" : "pl-4") : ""} ${dragging ? "opacity-50" : ""} ${computer?.offline && dimOffline ? "opacity-50" : ""}`}
        onPointerEnter={() => {
          if (doneable) hoveredDone = ownDone.current;
          showCardSoon();
        }}
        onPointerLeave={() => {
          if (hoveredDone === ownDone.current) hoveredDone = null;
          clearPrefetch();
          hideCardSoon();
        }}
        onKeyDown={(event) => {
          if (!doneable || renaming || !isDoneKey(event) || (event.target as HTMLElement).closest("input, textarea")) return;
          event.preventDefault();
          markDone();
        }}
        onPointerDown={hideCard}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
      >
        {renaming && edge ? (
          <div data-row className="sidebar-row relative z-10 mx-2 flex h-[54px] items-start rounded-control bg-hover-2 px-3 pt-2">
            <RenameField
              edge
              initial={item.label}
              onDone={(title) => {
                setRenaming(false);
                if (title !== null && title !== item.label) actions.onRename?.(item.id, title);
              }}
            />
          </div>
        ) : renaming && inbox ? (
          <div data-row className="sidebar-row relative z-10 mx-2 flex h-[50px] items-start gap-2 rounded-control bg-hover-2 px-2 py-[7px]">
            <RowProjectIcon image={projectImage} initial={projectInitial ?? projectName} chats={projectChats} />
            <RenameField
              inbox
              initial={item.label}
              onDone={(title) => {
                setRenaming(false);
                if (title !== null && title !== item.label) actions.onRename?.(item.id, title);
              }}
            />
          </div>
        ) : renaming ? (
          <div data-row className="sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-control bg-hover-2 px-2">
            <ChatMarkDot mark={mark} failed={item.details?.failed} background={item.background} />
            <RenameField
              initial={item.label}
              onDone={(title) => {
                setRenaming(false);
                if (title !== null && title !== item.label) actions.onRename?.(item.id, title);
              }}
            />
          </div>
        ) : inbox ? (
          <button
            data-row
            data-inbox-row
            type="button"
            onClick={() => onPick(item)}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.left + 24, rect.bottom + 4);
            }}
            disabled={archiving}
            aria-busy={archiving || undefined}
            aria-label={archiving ? `Deleting ${item.label}` : undefined}
            aria-current={active ? "page" : undefined}
            className={`sidebar-row relative z-10 mx-2 flex text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
              edge ? "h-[54px] flex-col rounded-control px-3 pt-2" : "h-[50px] items-start gap-2 rounded-control px-2 py-[7px]"
            } ${active ? "bg-hover-2" : edge ? "hover:bg-hover" : "hover:bg-hover-2"} ${archiving ? "opacity-30" : ""}`}
          >
            {!edge && <RowProjectIcon image={projectImage} initial={projectInitial ?? projectName} chats={projectChats} />}
            <InboxTitleLine
              variant={edge ? "inbox" : "classic"}
              item={item}
              linked={linked}
              lastAt={lastAt}
              now={now}
              hideTime={Boolean(shortcutHint) || Boolean(menu)}
              menuOpen={Boolean(menu)}
              doneable={doneable && !archiving}
              snoozable={snoozable}
            />
          </button>
        ) : (
          <button
            data-row
            type="button"
            onClick={() => onPick(item)}
            disabled={archiving}
            aria-busy={archiving || undefined}
            aria-label={archiving ? `Deleting ${item.label}` : undefined}
            aria-current={active ? "page" : undefined}
            className={`sidebar-row relative z-10 mx-2 flex ${twoLines ? "h-12 items-start pt-1.5" : "h-8 items-center"} rounded-control px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
              active ? "bg-hover-2" : "hover:bg-hover-2"
            } ${archiving ? "opacity-30" : ""}`}
          >
            <span className="sidebar-chat-initials relative size-6 shrink-0 items-center justify-center rounded-chip bg-field text-10 font-semibold text-ink-2">
              {recentInitials(item.label)}
              {mark === "running" ? (
                <span aria-hidden className="absolute -right-1 -top-1 flex rounded-full bg-surface p-px">
                  <SpinnerRing size={10} stroke={1.75} />
                </span>
              ) : (
                (mark !== "idle" || item.details?.failed) && (
                  <span
                    aria-hidden
                    className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ${mark === "idle" && item.details?.failed ? "bg-red" : railDotTone(mark)} ring-2 ring-surface`}
                  />
                )
              )}
            </span>
            {shownFamily && (
              <span className="mr-2">
                <RowProjectIcon image={projectImage} initial={projectInitial} chats={projectChats} />
              </span>
            )}
            <ChatMarkDot mark={mark} failed={item.details?.failed} background={item.background} topAligned={twoLines} />
            <span
              className={`sidebar-copy min-w-0 flex-1 truncate text-[length:calc(14px+var(--sidebar-delta))] ${prLines ? "leading-5" : ""} transition-[padding] duration-150 ${shortcutHint ? "pr-12" : snoozable ? "group-hover/row:pr-[98px]" : doneable ? "group-hover/row:pr-[76px]" : "group-hover/row:pr-6"} ${menu ? (snoozable ? "pr-[98px]" : doneable ? "pr-[76px]" : "pr-6") : ""} ${
                item.unread ? "font-semibold text-ink" : active ? "font-medium text-ink" : "font-medium text-ink-2"
              }`}
            >
              {linked.length > 0 || item.heartbeat ? (
                <span className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0">
                    <ChatTitle label={item.label} />
                  </span>
                  {linked.length > 0 && (
                    <span
                      data-chat-linked
                      role="img"
                      aria-label={`Linked to ${linked.map((end) => end.label).join(", ")}`}
                      title={`Linked to ${linked.map((end) => end.label).join(", ")}`}
                      className="flex shrink-0 font-normal text-ink-3"
                    >
                      <HugeiconsIcon icon={Link04Icon} size={12} strokeWidth={2} color="currentColor" />
                    </span>
                  )}
                  {item.heartbeat && (
                    <span data-chat-heartbeat role="img" aria-label={item.heartbeat} title="Heartbeat" className="flex shrink-0 font-normal text-ink-3">
                      <HugeiconsIcon icon={Pulse01Icon} size={12} strokeWidth={2} color="currentColor" />
                    </span>
                  )}
                </span>
              ) : (
                <ChatTitle label={item.label} />
              )}
              {item.worktreeCount !== undefined && !factLine && (
                <span className="block text-[length:calc(11px+var(--sidebar-delta))] font-normal text-ink-3">{linkChatWorktreesLabel(item.worktreeCount)}</span>
              )}
            </span>
          </button>
        )}

        {shownFamily && !renaming && !edge && (
          <FamilyBadge item={item} family={shownFamily} archiving={archiving} className="absolute top-[18px] left-[26px] z-20 ring-2 ring-surface" />
        )}
        {subchat && !collapsed && <span aria-hidden data-subchat-guide className="pointer-events-none absolute inset-y-0 left-[19px] w-px bg-line" />}
        {subchat && !collapsed && depth > 1 && (
          <span aria-hidden data-subchat-guide className="pointer-events-none absolute inset-y-0 left-[35px] w-px bg-line" />
        )}
        {edge && !renaming && (
          <InboxLine
            item={item}
            project={projectName}
            projectImage={projectImage}
            projectInitial={projectInitial}
            projectChats={projectChats}
            linkProjects={linkProjects}
            pullRequests={pullRequests}
            linearIssue={linearIssue}
            diff={diff}
            computer={rowComputer}
            archiving={archiving}
            active={active}
            waiting={waiting}
            subchat={subchat}
            depth={depth}
            family={shownFamily}
          />
        )}
        {inbox && !edge && !renaming && (
          <ClassicInboxLine
            item={item}
            project={projectName}
            linkProjects={linkProjects}
            pullRequests={pullRequests}
            linearIssue={linearIssue}
            diff={diff}
            computer={rowComputer}
            archiving={archiving}
            waiting={waiting}
            subchat={subchat}
            depth={depth}
          />
        )}

        {!inbox && factLine && !renaming && (
          <div
            data-chat-prs
            className={`sidebar-copy absolute bottom-1 ${subchat && !collapsed ? (depth > 1 ? "left-[68px] max-w-[calc(100%-104px)]" : "left-[52px] max-w-[calc(100%-88px)]") : "left-9 max-w-[calc(100%-72px)]"} z-20 flex min-w-0 items-center gap-2 ${archiving ? "opacity-30" : ""}`}
          >
            {facts.map((fact, index) => (
              <Fragment key={(fact as { key: string | null }).key}>
                {index > 0 && (
                  <span aria-hidden className="text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-3 opacity-60">
                    ·
                  </span>
                )}
                <span className="flex min-w-0 shrink items-center text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-3">{fact}</span>
              </Fragment>
            ))}
            {facts.length > 0 && hasChips && (
              <span aria-hidden className="text-[length:calc(12px+var(--sidebar-delta))] leading-4 text-ink-3 opacity-60">
                ·
              </span>
            )}
            {linearIssue && <LinearIssueChip issue={linearIssue} />}
            {shownPullRequests.map((pr) => (
              <PullRequestChip key={pr.url} pr={pr} item={item} labelled={pullRequests.length === 1} />
            ))}
            {hiddenPullRequests > 0 && (
              <span
                data-chat-pr-more
                aria-label={`${hiddenPullRequests} more pull request${hiddenPullRequests === 1 ? "" : "s"}`}
                className="shrink-0 text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums text-ink-3"
              >
                +{hiddenPullRequests}
              </span>
            )}
          </div>
        )}

        {doneable && !renaming && !shortcutHint && !archiving && (
          <div
            className={`absolute z-30 flex items-center gap-0.5 ${edge ? "right-4 top-2" : inbox ? "right-4 top-[7px]" : `${prLines ? "top-1" : "top-1/2 -translate-y-1/2"} right-10`} opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/row:opacity-100 ${menu ? "opacity-100" : ""}`}
          >
            {snoozable && (
              <Tooltip label={snoozeLabel} align="end" asChild>
                <button
                  type="button"
                  data-chat-snooze={snoozed ? "wake" : "snooze"}
                  aria-label={snoozed ? `Wake ${item.label}` : `Snooze ${item.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    snoozeNow();
                  }}
                  className="flex size-5 items-center justify-center rounded-inline text-ink-2 transition-colors hover:text-ink focus-visible:text-ink"
                >
                  <HugeiconsIcon icon={snoozed ? AlarmClockOffIcon : AlarmClockIcon} size={edge ? 14 : 13} strokeWidth={edge ? 1.8 : 2} color="currentColor" />
                </button>
              </Tooltip>
            )}
            <Tooltip label="Mark Done" keyHint="E" align="end">
              <button
                type="button"
                data-chat-done
                aria-label={`Mark ${item.label} Done`}
                onClick={(event) => {
                  event.stopPropagation();
                  markDone();
                }}
                className={`flex h-5 items-center gap-1 rounded-inline px-1 text-ink-2 transition-colors hover:text-ink focus-visible:text-ink ${edge ? "text-[length:calc(12px+var(--sidebar-delta))] font-medium" : "text-[length:calc(11.5px+var(--sidebar-delta))] font-semibold"}`}
              >
                <HugeiconsIcon icon={Tick02Icon} size={edge ? 14 : 12} strokeWidth={edge ? 1.8 : 2.5} color="currentColor" />
                Done
              </button>
            </Tooltip>
          </div>
        )}
        {shortcutHint && !renaming && !menu && (
          <ShortcutKeys
            shortcut={shortcutHint}
            aria-hidden="true"
            className={`pointer-events-none absolute z-30 ${inbox ? "right-4 top-2" : `top-1.5 ${collapsed ? "right-1" : "right-3"}`}`}
          />
        )}
        {archiving && (
          <div role="status" className="absolute inset-y-0 left-2 right-2 z-40 flex items-center justify-center">
            <span className="flex h-6 items-center gap-1.5 rounded-full bg-surface px-2.5 text-12 font-medium text-ink shadow-card">
              <SpinnerRing size={12} />
              {!collapsed && "Deleting..."}
            </span>
          </div>
        )}
        {!item.pending && !collapsed && !inbox && !renaming && !shortcutHint && (
          <button
            ref={triggerRef}
            type="button"
            disabled={archiving}
            aria-label="Chat actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              if (menu) setMenu(null);
              else openMenu(rect.left, rect.bottom + 4);
            }}
            className={`absolute right-3 ${prLines ? "top-1" : "top-1/2 -translate-y-1/2"} z-20 flex size-6 items-center justify-center rounded-chip text-ink-3 transition-[opacity,background-color,color] duration-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 ${
              menu ? "bg-hover text-ink opacity-100" : "opacity-0"
            }`}
          >
            <HugeIcon icon={MoreVerticalIcon} size={16} />
          </button>
        )}

        {menu && (
          <ChatMenu
            item={item}
            position={menu}
            trigger={triggerRef}
            onClose={() => setMenu(null)}
            onRename={() => setRenaming(true)}
            onLink={() => setLinking(menu)}
            linked={linked.length > 0}
            actions={{
              ...actions,
              onArchive: actions.onArchive
                ? async (id, mode, plan) => {
                    if (archivePending.current) return;
                    archivePending.current = true;
                    setArchiving(true);
                    try {
                      await actions.onArchive?.(id, mode, plan);
                    } finally {
                      archivePending.current = false;
                      setArchiving(false);
                    }
                  }
                : undefined,
            }}
          />
        )}
        {linking && (
          <LinkIssuePopover
            position={linking}
            onPick={(issue) => {
              setLinking(null);
              actions.onLinkIssue?.(item.id, issue.key, issue.workspace);
            }}
            onClose={() => setLinking(null)}
          />
        )}
      </div>
      {card &&
        !menu &&
        createPortal(
          <ChatHoverCard item={item} linked={linked} position={card} onPointerEnter={clearHover} onPointerLeave={hideCardSoon} onOpenLink={hideCard} />,
          document.body,
        )}
    </>
  );
});
