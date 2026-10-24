import { linkChatWorktreesLabel } from "@milagre/shared/worktree-link";
import { ChatTitle } from "./ChatTitle";
import { issueChipLabel, LINK_PR_HINT, type LinearIssue } from "@milagre/shared/linear";
import { LinearLogo } from "../ProviderLogo";
import { LinearIssuePicker } from "../LinearIssuePicker";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive02Icon,
  BubbleChatIcon,
  EthernetPortIcon,
  CircleDotIcon,
  CircleIcon,
  Copy01Icon,
  FileEditIcon,
  Folder01Icon,
  FolderOpenIcon,
  LaptopIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  Link04Icon,
  LinkSquare02Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  Pulse01Icon,
  Refresh01Icon,
  ShieldAlertIcon,
  SourceCodeIcon,
  Tick02Icon,
  Unlink04Icon,
} from "@hugeicons/core-free-icons";
import type { LinkedEnd } from "./SidebarLinks";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { ShortcutKeys } from "@/components/primitives/ShortcutKeys";
import { archiveChoices, type ArchiveMode, type ArchivePlan } from "@/lib/archive";
import { folderName, formatLineCount, type ChatMark } from "@/lib/chat-list";
import { rowPullRequests } from "@/lib/chat-pull-requests";
import { useEditors } from "@/lib/editors";
import type { AgentPort, DiffStat, PullRequest } from "@/model";
import { portComputer, portUrl, unreachablePortReason } from "@/lib/ports";
import { BLOCKERS, pullRequestBlockers, pullRequestPresentation } from "@/lib/pr-blockers";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { chatMarkTone } from "@milagre/shared/chats";
import { backgroundLabel } from "@milagre/shared/chat-activity";
import { RELOAD_HINT } from "@milagre/shared/chat-reload";
import { activityAgo, DESKTOP_CHAT_ROW_SHOW, type ChatRowShow } from "@milagre/shared/chat-row";
import { useDisplayNow } from "../../lib/display-clock";
import type { BotMark } from "@/lib/bot-marks";
import { BotAvatar } from "../bots/BotAvatar";

/** Now, to the minute, while `on`; 0 otherwise, so rows that don't show the time never re-render for it. */
function useMinute(on: boolean) {
  const now = useDisplayNow(30_000, on);
  return on ? now : 0;
}

const markToneClass = { accent: "text-accent", orange: "text-orange", red: "text-red", ink3: "text-ink-3" } as const;

const toneClass = { red: "text-red", orange: "text-orange" } as const;

type HugeIconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function HugeIcon({ icon, size = 16 }: { icon: HugeIconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

/** What the hover card tells about a chat. */
type ChatDetails = {
  branch?: string;
  path?: string;
  diff?: DiffStat;
  /** PRs the chat created or merged, then its worktree branch's PR, in the order they were made. */
  pullRequests?: PullRequest[];
  /** The Linear issue the chat's Worktree was started from or names. */
  linearIssue?: LinearIssue;
  /** The key the chat's Worktree is stored as linked to (Worktree.linearIssue). Only while Linear is on. */
  linearKey?: string;
  /** The chat has its own Worktree that another chat doesn't share, so "Link issue…" is offered. Only while Linear is on. */
  linkable?: boolean;
  /** The chat's last turn failed. */
  failed?: boolean;
  /** Ports the chat's commands listen on. */
  ports?: AgentPort[];
  /** When the chat last got a message or a reply ended (ChatSummary.lastAt). */
  lastAt?: number;
};

/** The computer a row's chat lives on, shown on its second line once there are two or more computers. */
export type RowComputer = { name: string; offline: boolean };

export type SidebarRecent = {
  id: string;
  /** A local Chat preview can be opened, but cannot be edited until the host accepts it. */
  pending?: boolean;
  label: string;
  worktreeCount?: number;
  prompt?: string;
  /** The mark at the left of the row; idle when absent. */
  mark?: ChatMark;
  /** With a background mark: how many background agents still work (chat-activity.mjs). */
  background?: number;
  /** Whether the chat is unread, whatever its mark shows. */
  unread?: boolean;
  /** In the Pinned section, at `pinOrder` among the pinned chats. */
  pinned?: boolean;
  pinOrder?: number;
  /** An enabled heartbeat checks back on this Chat: its hover-card line, "Heartbeat · every 15 min · next 10:45". */
  heartbeat?: string;
  details?: ChatDetails;
};

export type ChatRowActions = {
  onRename?: (id: string, title: string) => void;
  onMarkUnread?: (id: string, unread: boolean) => void;
  /** Restarts the chat's agent so it picks up new MCP servers, skills or a sign-in (stopping a running turn). */
  onReload?: (id: string) => void;
  /** Pins the chat at `order` among the pinned chats (the end when left out), or unpins it (null). */
  onPin?: (id: string, order?: number | null) => void;
  onReveal?: (id: string) => void;
  onOpenInEditor?: (id: string) => void;
  /** The chat is on another Mac: the menu leaves out what only acts on this one (Finder, the editor). */
  remote?: boolean;
  /** Opens the chat with its "Commit and open PR" dialog. */
  onCommit?: (id: string) => void;
  /** Looks at the chat's worktree when "Archive" is clicked, to decide what the confirm step offers. */
  onArchiveCheck?: (id: string) => Promise<ArchivePlan>;
  onArchive?: (id: string, mode: ArchiveMode, plan: ArchivePlan) => Promise<unknown> | void;
  /** Links the chat's Worktree to a Linear issue by key. */
  onLinkIssue?: (id: string, key: string, workspace?: string) => void;
  /** Removes the Worktree's stored Linear issue link. */
  onUnlinkIssue?: (id: string) => void;
  /** "Link with…": the chat list that leads to the Link popover, at the menu's place. */
  onLinkWith?: (id: string, anchor: { top: number; left: number }) => void;
  /** "Remove Link with…": the chat's Links, at the menu's place. */
  onRemoveLink?: (id: string, anchor: { top: number; left: number }) => void;
};

const NO_LINKS: LinkedEnd[] = [];

/** What the confirm step offers when nothing is known about the worktree: only hide the chat. */
const HIDE_ONLY: ArchivePlan = { milagreOwned: false, shared: false, status: null };

const MARK_LABEL: Record<Exclude<ChatMark, "idle">, string> = {
  question: "Asking you",
  waiting: "Waiting for you",
  delegated: "Working on a Delegation",
  running: "Running",
  background: "Working in the background",
  unread: "Unread",
};

/** The mark's words, a background mark with its count: "2 background tasks running". */
const markLabel = (mark: Exclude<ChatMark, "idle">, background = 0) =>
  mark === "background" && background ? `${backgroundLabel(background)} running` : MARK_LABEL[mark];

/** Work going on with no turn: a still ring around how many background tasks run, so it reads apart from running. */
function BackgroundMark({ count = 0 }: { count?: number }) {
  return (
    <span className="flex size-3 items-center justify-center rounded-full border-[1.5px] border-accent text-[7px] font-bold leading-none tabular-nums text-accent">
      {count > 9 ? "9+" : count || ""}
    </span>
  );
}

const HOVER_CARD_DELAY = 500;
// Long enough for a pointer crossing the list not to read every chat, short enough to finish before most clicks.
const PREFETCH_DELAY = 90;
/** Time to cross from the row to the card before it closes, so its PR links can be clicked. */
const HOVER_CARD_GRACE = 250;
/** PR chips the row has room for; the rest are a count, and the hover card lists them all. */
const ROW_PR_LIMIT = 2;
const HOVER_CARD_WIDTH = 256;
const MENU_WIDTH = 240;

type MenuEntry = {
  key: string;
  label: string;
  icon?: HugeIconData;
  /** Drawn instead of `icon`, e.g. a brand mark. */ leading?: ReactNode;
  /** What the item is for, shown on hover. */
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  archiveChoice?: boolean;
};

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/* ─────────────────────────────────────────────────────────
 * CHAT MARK
 * One slot left of the label. A question shows a chat bubble,
 * an approval a shield, running spins a ring, unread is a plain
 * accent dot, and an idle chat keeps a faint dot so labels stay
 * aligned.
 * ───────────────────────────────────────────────────────── */
/** Marks that ask for you draw an icon, so a question and an approval read apart. The shield is orange like the approval card. */
const MARK_ICON = {
  question: { icon: BubbleChatIcon },
  waiting: { icon: ShieldAlertIcon },
  delegated: { icon: Link04Icon },
} satisfies Partial<Record<ChatMark, { icon: HugeIconData }>>;

function MarkIcon({ mark }: { mark: keyof typeof MARK_ICON }) {
  return (
    <span className={`flex ${markToneClass[chatMarkTone(mark)]}`}>
      <HugeiconsIcon icon={MARK_ICON[mark].icon} size={13} strokeWidth={2} color="currentColor" />
    </span>
  );
}

export function ChatMarkDot({
  mark,
  failed = false,
  background,
  topAligned = false,
}: {
  mark: ChatMark;
  failed?: boolean;
  background?: number;
  topAligned?: boolean;
}) {
  const failure = mark === "idle" && failed;
  const label = failure ? "Last turn failed" : mark === "idle" ? "" : markLabel(mark, background);
  const dot = failure ? "size-2 bg-red" : mark === "unread" ? "size-2 bg-accent" : "size-1.5 bg-ink-3 opacity-40";
  return (
    <span className={`sidebar-copy mr-2 flex size-3 shrink-0 items-center justify-center ${topAligned ? "mt-1" : ""}`}>
      <span
        data-slot="chat-mark"
        data-mark={failure ? "failed" : mark}
        {...(label ? { role: "img", "aria-label": label, title: label } : { "aria-hidden": true })}
        className={mark === "running" || mark === "background" ? "flex" : mark in MARK_ICON ? "flex" : `rounded-full ${dot}`}
      >
        {mark === "running" && <SpinnerRing size={12} color="var(--accent)" />}
        {mark === "background" && <BackgroundMark count={background} />}
        {mark in MARK_ICON && <MarkIcon mark={mark as keyof typeof MARK_ICON} />}
      </span>
    </span>
  );
}

function recentInitials(label: string) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

// memo: the sidebar rebuilds on streamed batches, and a row only needs to render when its own item changes.
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
  bot,
}: {
  item: SidebarRecent;
  active: boolean;
  collapsed: boolean;
  onPick: (item: SidebarRecent) => void;
  /** The pointer has rested on the row: a chance to read the chat's page before the click. */
  onHover?: (item: SidebarRecent) => void;
  actions: ChatRowActions;
  shortcutHint?: string;
  computer?: RowComputer;
  /** What the second line shows (the Filters menu's Show). */
  show?: ChatRowShow;
  /** Dim the row itself when its computer is offline; false inside a section that is already dimmed. */
  dimOffline?: boolean;
  /** The row is being dragged to a new place. */
  dragging?: boolean;
  /** The canvas Links that reach the chat's Worktree: a Link icon on the row, one line each in the hover card. */
  linked?: LinkedEnd[];
  /** The bot that opened the chat and still runs it: "from <Bot name>" leads the second line. */
  bot?: BotMark;
}) {
  const [archiving, setArchiving] = useState(false);
  const archivePending = useRef(false);
  const mark = item.mark ?? "idle";
  const pullRequests = !collapsed && show.pullRequests ? rowPullRequests(item.details?.pullRequests ?? []) : [];
  const linearIssue = !collapsed && show.linearIssue ? item.details?.linearIssue : undefined;
  const hasPullRequests = pullRequests.length > 0;
  // The chip row shows for a Linear issue alone, too.
  const hasChips = hasPullRequests || linearIssue !== undefined;
  const shownPullRequests = pullRequests.slice(0, ROW_PR_LIMIT);
  const hiddenPullRequests = pullRequests.length - shownPullRequests.length;
  const rowComputer = show.computer ? computer : undefined;
  const branch = show.branch ? item.details?.branch : undefined;
  const diff = show.diff && item.details?.diff && (item.details.diff.added > 0 || item.details.diff.removed > 0) ? item.details.diff : undefined;
  const lastAt = show.lastActivity ? item.details?.lastAt : undefined;
  const now = useMinute(lastAt !== undefined);
  // Each shown fact, in order, joined by dots; the chips follow.
  const facts: ReactNode[] = [];
  if (bot && !collapsed)
    facts.push(
      <span key="bot" data-bot-mark={bot.id} className="flex shrink-0 items-center gap-1">
        <BotAvatar color={bot.color} body={bot.body} size={14} />
        from {bot.name}
      </span>,
    );
  if (rowComputer)
    facts.push(
      <span key="computer" data-chat-computer className="flex min-w-0 shrink items-center gap-1 truncate">
        <HugeiconsIcon icon={LaptopIcon} size={12} strokeWidth={2} color="currentColor" className="shrink-0" />
        {rowComputer.offline ? `${rowComputer.name}, offline` : rowComputer.name}
      </span>,
    );
  const factLine = facts.length > 0 || Boolean(branch || diff || lastAt !== undefined) || hasChips;
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
  const twoLines = factLine || item.worktreeCount !== undefined;
  // A Link chat alone keeps its Worktrees under the title; any second-line fact moves it there.
  const prLines = factLine;
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [card, setCard] = useState<{ top: number; left: number; flip: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The issue picker opened from the menu's "Link issue…", at the menu's place.
  const [linking, setLinking] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);

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
  // A pointer resting on the row is about to click it: the chat's page is read now, so the click paints at once.
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
    // Back on the row from the card: the card stays as it is. A chat being dragged over the row doesn't open it.
    if (menu || renaming || card || document.documentElement.hasAttribute("data-chat-drag")) return;
    hoverTimer.current = window.setTimeout(() => {
      const row = rowRef.current;
      if (!row) return;
      const rect = row.getBoundingClientRect();
      const sidebar = row.closest("aside")?.getBoundingClientRect() ?? rect;
      // Rows low in the window open the card upwards so it stays on screen.
      const flip = rect.top > window.innerHeight - 240;
      setCard({ top: flip ? window.innerHeight - rect.bottom - 4 : rect.top - 4, left: sidebar.right + 8, flip });
    }, HOVER_CARD_DELAY);
  };

  // Leaving the row or the card gives the pointer time to reach the other one.
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
        className={`group/row relative ${dragging ? "opacity-50" : ""} ${computer?.offline && dimOffline ? "opacity-50" : ""}`}
        onPointerEnter={showCardSoon}
        onPointerLeave={() => {
          clearPrefetch();
          hideCardSoon();
        }}
        onPointerDown={hideCard}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
      >
        {renaming ? (
          <div data-row className="sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] bg-hover-2 px-2">
            <ChatMarkDot mark={mark} failed={item.details?.failed} background={item.background} />
            <RenameField
              initial={item.label}
              onDone={(title) => {
                setRenaming(false);
                if (title !== null && title !== item.label) actions.onRename?.(item.id, title);
              }}
            />
          </div>
        ) : (
          <button
            data-row
            type="button"
            onClick={() => onPick(item)}
            disabled={archiving}
            aria-busy={archiving || undefined}
            aria-label={archiving ? `Archiving ${item.label}` : undefined}
            aria-current={active ? "page" : undefined}
            className={`sidebar-row relative z-10 mx-2 flex ${twoLines ? "h-[46px] items-start pt-1.5" : "h-8 items-center"} rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
              active ? "bg-hover-2" : "hover:bg-hover-2"
            } ${archiving ? "opacity-30" : ""}`}
          >
            <span className="sidebar-chat-initials relative size-6 shrink-0 items-center justify-center rounded-[6px] bg-field text-[10px] font-semibold text-ink-2">
              {recentInitials(item.label)}
              {mark === "running" ? (
                <span aria-hidden className="absolute -right-1 -top-1 flex rounded-full bg-surface p-px">
                  <SpinnerRing size={10} stroke={1.75} color="var(--accent)" />
                </span>
              ) : (
                (mark !== "idle" || item.details?.failed) && (
                  <span
                    aria-hidden
                    className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ${mark === "idle" && item.details?.failed ? "bg-red" : "bg-accent"} ring-2 ring-surface`}
                  />
                )
              )}
            </span>
            <ChatMarkDot mark={mark} failed={item.details?.failed} background={item.background} topAligned={twoLines} />
            <span
              className={`sidebar-copy min-w-0 flex-1 truncate text-[length:calc(14px+var(--sidebar-delta))] ${prLines ? "leading-5" : ""} transition-[padding] duration-150 ${shortcutHint ? "pr-12" : "group-hover/row:pr-6"} ${menu ? "pr-6" : ""} ${
                item.unread ? "font-semibold text-ink" : active ? "font-medium text-ink" : "font-medium text-ink-2"
              }`}
            >
              {linked.length > 0 || item.heartbeat ? (
                // The icons follow the title, like the presence glyphs Orca puts after a worktree's name.
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

        {factLine && !renaming && (
          <div
            data-chat-prs
            className={`sidebar-copy absolute bottom-1 left-9 z-20 flex max-w-[calc(100%-72px)] min-w-0 items-center gap-2 ${archiving ? "opacity-30" : ""}`}
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
              <PullRequestChip key={pr.url} pr={pr} labelled={pullRequests.length === 1} />
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

        {shortcutHint && !renaming && !menu && (
          <ShortcutKeys
            shortcut={shortcutHint}
            aria-hidden="true"
            className={`pointer-events-none absolute top-1.5 z-30 ${collapsed ? "right-1" : "right-3"}`}
          />
        )}
        {archiving && (
          // Over the whole row, its pull requests included: the row stays in place, faded and untouchable, until the archive ends.
          <div role="status" className="absolute inset-y-0 left-2 right-2 z-40 flex items-center justify-center">
            <span className="flex h-6 items-center gap-1.5 rounded-full bg-surface px-2.5 text-[12px] font-medium text-ink shadow-card">
              <SpinnerRing size={12} />
              {!collapsed && "Archiving..."}
            </span>
          </div>
        )}
        {!item.pending && !collapsed && !renaming && !shortcutHint && (
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
            className={`absolute right-3 ${prLines ? "top-1" : "top-1/2 -translate-y-1/2"} z-20 flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-[opacity,background-color,color] duration-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 ${
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
      {/* Outside the row, so presses in the card don't reach the row's handlers through the portal. */}
      {card &&
        !menu &&
        createPortal(
          <ChatHoverCard item={item} linked={linked} position={card} onPointerEnter={clearHover} onPointerLeave={hideCardSoon} onOpenLink={hideCard} />,
          document.body,
        )}
    </>
  );
});

/** Merged is purple, a blocked PR takes its first blocker's tone, running CI is orange like GitHub's own dot, other open PRs are green. */
function prTone(pr: PullRequest) {
  return { purple: "text-purple-500", red: "text-red", orange: "text-orange", green: "text-green" }[pullRequestPresentation(pr).tone];
}

function prIcon(pr: PullRequest) {
  return { merged: GitMergeIcon, ready: Tick02Icon, checking: CircleDotIcon, open: GitPullRequestIcon }[pullRequestPresentation(pr).icon];
}

const isReadyToMerge = (pr: PullRequest) => pullRequestPresentation(pr).ready;
/** CI is still running and nothing else blocks the PR; a failure is a blocker and shows as one. */
const isChecking = (pr: PullRequest) => pullRequestPresentation(pr).checking;

/** One PR under the chat's title. Only a chat's single PR has room to spell out its blocker or "Ready". */
function LinearIssueChip({ issue }: { issue: LinearIssue }) {
  return (
    <button
      type="button"
      data-linear-issue-chip
      title={issue.title}
      aria-label={`Open Linear issue ${issue.key}: ${issue.title}`}
      onClick={(event) => {
        event.stopPropagation();
        window.open(issue.url, "_blank", "noopener,noreferrer");
      }}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums text-ink-3 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <LinearLogo size={11} />
      <span className="truncate">{issueChipLabel(issue)}</span>
    </button>
  );
}

function PullRequestChip({ pr, labelled }: { pr: PullRequest; labelled: boolean }) {
  const blocker = pullRequestBlockers(pr)[0];
  const readyToMerge = isReadyToMerge(pr);
  const checking = isChecking(pr);
  return (
    <Tooltip
      label={
        blocker
          ? `${BLOCKERS[blocker].long} · Pull request #${pr.number}`
          : readyToMerge
            ? `Ready to merge · Pull request #${pr.number}`
            : checking
              ? `CI checks running · Pull request #${pr.number}`
              : `${pr.state === "MERGED" ? "Merged" : "Open"} pull request #${pr.number}`
      }
      side="bottom"
      className="min-w-0"
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${pr.state === "MERGED" ? "merged " : ""}pull request #${pr.number}${blocker ? `, ${BLOCKERS[blocker].short.toLowerCase()}` : readyToMerge ? ", ready to merge" : checking ? ", CI running" : ""}`}
        data-chat-pr
        className="group/pr inline-flex min-w-0 items-center gap-1 rounded-sm text-[length:calc(12px+var(--sidebar-delta))] leading-4 tabular-nums text-ink-3 no-underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={(event) => event.stopPropagation()}
      >
        <span aria-hidden className={`inline-flex group-hover/pr:hidden group-focus-visible/pr:hidden ${prTone(pr)}`}>
          <HugeIcon icon={prIcon(pr)} size={12} />
        </span>
        <span aria-hidden className="hidden group-hover/pr:inline-flex group-focus-visible/pr:inline-flex">
          <HugeIcon icon={LinkSquare02Icon} size={12} />
        </span>
        <span className="truncate">#{pr.number}</span>
        {labelled && blocker && <span className={`shrink-0 ${toneClass[BLOCKERS[blocker].tone]}`}>{BLOCKERS[blocker].short}</span>}
        {labelled && readyToMerge && <span className="shrink-0 text-green">Ready</span>}
        {labelled && checking && <span className="shrink-0 text-orange">CI running</span>}
      </a>
    </Tooltip>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      defaultValue={initial}
      aria-label="Chat name"
      maxLength={120}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value.trim());
        } else if (event.key === "Escape") {
          // Consumed here, so Escape doesn't also stop the open chat's turn.
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value.trim())}
      className="sidebar-copy min-w-0 flex-1 bg-transparent text-[length:calc(14px+var(--sidebar-delta))] font-medium text-ink outline-none"
    />
  );
}

/* ─────────────────────────────────────────────────────────
 * HOVER CARD
 * Opens beside the sidebar after a short rest on a row, and stays
 * while the pointer is on it so its PRs can be opened. All of it is
 * already in the project state (the diff stat is cached by
 * useWorktreeDiffs), so it never waits on git.
 * ───────────────────────────────────────────────────────── */
function ChatHoverCard({
  item,
  linked,
  position,
  onPointerEnter,
  onPointerLeave,
  onOpenLink,
}: {
  item: SidebarRecent;
  linked: LinkedEnd[];
  position: { top: number; left: number; flip: boolean };
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** A PR in the card was opened; the card closes. */
  onOpenLink: () => void;
}) {
  const { details = {} } = item;
  const mark = item.mark ?? "idle";
  const status =
    mark !== "idle"
      ? { label: markLabel(mark, item.background), tone: markToneClass[chatMarkTone(mark)] }
      : details.failed
        ? { label: "Last turn failed", tone: "text-red" }
        : null;
  return (
    <div
      data-chat-hover-card
      aria-label={item.label}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="fixed z-[60] rounded-[12px] bg-surface p-3 shadow-overlay"
      style={{
        left: position.left,
        width: HOVER_CARD_WIDTH,
        ...(position.flip ? { bottom: position.top } : { top: position.top }),
        animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: position.flip ? "bottom left" : "top left",
      }}
    >
      <div className="line-clamp-3 text-[13.5px] font-semibold leading-snug text-ink">{item.label}</div>
      <div className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-ink-2">
        {status && (
          <CardLine
            icon={
              <span className="flex size-4 items-center justify-center">
                <ChatMarkDotInline mark={mark} failed={Boolean(details.failed)} background={item.background} />
              </span>
            }
          >
            <span className={status.tone}>{status.label}</span>
          </CardLine>
        )}
        {item.heartbeat && (
          <CardLine icon={<HugeiconsIcon icon={Pulse01Icon} size={14} strokeWidth={1.8} color="currentColor" />}>
            <span data-chat-card-heartbeat className="min-w-0 truncate">
              {item.heartbeat}
            </span>
          </CardLine>
        )}
        {details.pullRequests?.length ? (
          <ScrollArea data-chat-card-prs className="-mx-1 flex max-h-[148px] flex-col gap-0.5">
            {details.pullRequests.map((pr) => {
              const blocker = pullRequestBlockers(pr)[0];
              return (
                <a
                  key={pr.url}
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-chat-card-pr
                  onClick={onOpenLink}
                  className="flex min-w-0 items-center gap-2 rounded-[6px] px-1 py-0.5 text-ink-2 no-underline hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className={`flex size-4 shrink-0 items-center justify-center ${prTone(pr)}`}>
                    <HugeIcon icon={prIcon(pr)} size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate leading-snug">
                    <span className="tabular-nums">#{pr.number}</span>
                    {pr.title ? ` · ${pr.title}` : ""}
                  </span>
                  {blocker && <span className={`shrink-0 ${toneClass[BLOCKERS[blocker].tone]}`}>{BLOCKERS[blocker].short}</span>}
                  {isReadyToMerge(pr) && <span className="shrink-0 text-green">Ready to merge</span>}
                  {isChecking(pr) && <span className="shrink-0 text-orange">CI running</span>}
                </a>
              );
            })}
          </ScrollArea>
        ) : null}
        {details.ports?.length ? (
          <div data-chat-card-ports className="flex min-w-0 items-start gap-2">
            <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink-3">
              <HugeIcon icon={EthernetPortIcon} size={14} />
            </span>
            <span className="flex min-w-0 flex-wrap gap-1">
              {details.ports.map((port) => {
                const computer = portComputer(port);
                const url = portUrl(port);
                const chip = "rounded-[6px] bg-hover px-1.5 py-0.5 font-mono text-[11.5px] tabular-nums text-ink-2";
                // Another computer's port opens at its LAN or tailnet IP; one this Mac can't reach is shown, not linked.
                return computer && !url ? (
                  <span
                    key={port.port}
                    data-chat-card-port
                    data-port-remote
                    title={`${port.command} · ${unreachablePortReason(port, computer)}`}
                    className={chip}
                  >
                    :{port.port} <span className="font-sans text-ink-3">on {computer}</span>
                  </span>
                ) : (
                  <a
                    key={port.port}
                    href={url ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-chat-card-port
                    {...(computer ? { "data-port-remote": true } : {})}
                    title={`${port.command} · open ${url}`}
                    onClick={onOpenLink}
                    className={`${chip} no-underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
                  >
                    :{port.port}
                    {computer ? <span className="font-sans text-ink-3"> on {computer}</span> : null}
                  </a>
                );
              })}
            </span>
          </div>
        ) : null}
        {details.diff && (
          <CardLine icon={<HugeIcon icon={FileEditIcon} size={14} />}>
            {details.diff.added === 0 && details.diff.removed === 0 ? (
              <span className="text-ink-3">No changes</span>
            ) : (
              <span className="tabular-nums">
                <span className="text-diff-add">+{formatLineCount(details.diff.added)}</span>{" "}
                <span className="text-diff-remove">−{formatLineCount(details.diff.removed)}</span>
              </span>
            )}
          </CardLine>
        )}
        {details.branch && (
          <CardLine icon={<HugeIcon icon={GitBranchIcon} size={14} />}>
            <span className="truncate">{details.branch}</span>
          </CardLine>
        )}
        {details.linearIssue && (
          <CardLine icon={<LinearLogo size={13} />}>
            <a
              href={details.linearIssue.url}
              target="_blank"
              rel="noopener noreferrer"
              data-chat-card-linear-issue
              onClick={onOpenLink}
              className="min-w-0 truncate text-ink-2 no-underline hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {issueChipLabel(details.linearIssue)} · {details.linearIssue.title}
            </a>
          </CardLine>
        )}
        {details.linearKey && !(details.branch ?? "").toLowerCase().includes(details.linearKey.toLowerCase()) && (
          <CardLine icon={<LinearLogo size={13} />}>
            <span data-chat-card-link-hint className="min-w-0 whitespace-normal text-[12px] leading-snug text-ink-3">
              {LINK_PR_HINT(details.linearKey)}
            </span>
          </CardLine>
        )}
        {details.path && (
          <CardLine icon={<HugeIcon icon={Folder01Icon} size={14} />}>
            <span className="truncate">{folderName(details.path)}</span>
          </CardLine>
        )}
        {linked.length > 0 && (
          <div data-chat-card-links className="flex min-w-0 items-start gap-2">
            <span className="flex h-[18px] w-4 shrink-0 items-center justify-center text-ink-3">
              <HugeIcon icon={Link04Icon} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[11.5px] text-ink-3">Linked with</span>
              {linked.map((end) => (
                <span key={end.linkId} data-chat-card-link className="truncate leading-snug">
                  {end.label}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A mark without its row: the hover card's status line, and the collapsed rail's list of live chats. */
export function ChatMarkDotInline({ mark, failed, background }: { mark: ChatMark; failed: boolean; background?: number }) {
  if (mark === "running") return <SpinnerRing size={12} color="var(--accent)" />;
  if (mark === "background") return <BackgroundMark count={background} />;
  if (mark in MARK_ICON) return <MarkIcon mark={mark as keyof typeof MARK_ICON} />;
  return <span aria-hidden className={`size-2 rounded-full ${mark === "idle" && failed ? "bg-red" : "bg-accent"}`} />;
}

function CardLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-3">{icon}</span>
      <span className="flex min-w-0 flex-1">{children}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * ACTIONS MENU
 * From the row's ⋮ button or a right-click. Archive hides the
 * chat for good (there is no archived list), so it asks twice.
 * ───────────────────────────────────────────────────────── */
/** The issue list over the menu's place, for "Link issue…". Picking an issue hands its key up and closes. */
function LinkIssuePopover({ position, onPick, onClose }: { position: { x: number; y: number }; onPick: (issue: LinearIssue) => void; onClose: () => void }) {
  useDismiss(true, onClose, (target) => !!target.closest("[data-picker-panel]"));
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(position.y);
  // Opens above the menu's place when there isn't room below, and never above the window's top edge.
  // Measured again as the issue list fills in, since its height isn't known on the first paint.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const height = element.getBoundingClientRect().height;
      setTop(position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height - 8) : position.y);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [position.y]);
  return createPortal(
    <div ref={ref} data-linear-link-picker className="fixed z-[70]" style={{ top, left: Math.min(position.x, window.innerWidth - 420 - 8) }}>
      <LinearIssuePicker className="w-[420px] max-w-[calc(100vw-2rem)]" title="Link a Linear issue" onPick={onPick} onClose={onClose} />
    </div>,
    document.body,
  );
}

function ChatMenu({
  item,
  position,
  trigger,
  onClose,
  onRename,
  onLink,
  linked,
  actions,
}: {
  item: SidebarRecent;
  position: { x: number; y: number };
  /** The ⋮ button toggles the menu itself, so a press on it isn't an outside press. */
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onRename: () => void;
  onLink: () => void;
  /** A canvas Link reaches the chat's Worktree, so "Remove Link with…" is offered. */
  linked: boolean;
  actions: ChatRowActions;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [archiveArmed, setArchiveArmed] = useState(false);
  // What the confirm step offers: null until the worktree has been looked at.
  const [plan, setPlan] = useState<ArchivePlan | null>(actions.onArchiveCheck ? null : HIDE_ONLY);
  const [top, setTop] = useState(position.y);
  const { details = {} } = item;
  const running = item.mark === "running" || item.mark === "waiting" || item.mark === "question";

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, []);

  // The confirm step can add items and a line, so the height is measured again with it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // Opens upwards when there isn't room below.
    const height = menu.getBoundingClientRect().height;
    setTop(position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height - 8) : position.y);
    if (archiveArmed) menu.querySelector<HTMLElement>("[data-archive-choice]:not(:disabled)")?.focus();
  }, [position.y, archiveArmed, plan]);

  // The worktree is checked as the menu opens, so "Archive" goes straight to its choice instead of
  // flashing a checking row. Archive stays disabled until the check is back.
  useEffect(() => {
    if (!actions.onArchiveCheck || !actions.onArchive) return;
    let live = true;
    // A worktree that can't be checked only hides the chat, as before.
    actions.onArchiveCheck(item.id).then(
      // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
      (next) => live && setPlan(next),
      () => live && setPlan(HIDE_ONLY),
    );
    return () => {
      live = false;
    };
    // Checked once per opening; the menu remounts each time it opens.
  }, []);

  useDismiss(true, onClose, (target) => !!(menuRef.current?.contains(target) || trigger.current?.contains(target)));

  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  const { editor } = useEditors();
  const copy = (text: string) => run(() => void navigator.clipboard.writeText(text).catch(() => {}));

  const confirm = archiveArmed && plan ? archiveChoices({ plan, running }) : null;
  const archiveItems: Array<MenuEntry> =
    !confirm || !plan
      ? [{ key: "archive", label: "Archive", icon: Archive02Icon, onSelect: () => setArchiveArmed(true), disabled: !actions.onArchive || !plan }]
      : confirm.choices.map((choice) => ({
          key: `archive-${choice.mode}`,
          label: choice.label,
          icon: Archive02Icon,
          onSelect: run(() => actions.onArchive?.(item.id, choice.mode, plan)),
          danger: choice.tone === "danger",
          archiveChoice: true,
        }));

  // Enter confirms the armed archive wherever focus is, since a mouse click on "Archive" leaves it on the page.
  // A row focused with the arrow keys keeps Enter for itself.
  const firstArchiveItem = archiveItems[0];
  const confirmEntry = archiveItems.length === 1 && firstArchiveItem?.archiveChoice && !firstArchiveItem.disabled ? firstArchiveItem : null;
  useEffect(() => {
    if (!confirmEntry) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches("[data-menu-row]") && !active.matches("[data-archive-choice]")) return;
      event.preventDefault();
      event.stopPropagation();
      confirmEntry.onSelect();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirmEntry]);

  const items: Array<MenuEntry | "divider"> = [
    { key: "copy-path", label: "Copy path", icon: Copy01Icon, onSelect: copy(details.path ?? ""), disabled: !details.path },
    { key: "copy-branch", label: "Copy branch name", icon: GitBranchIcon, onSelect: copy(details.branch ?? ""), disabled: !details.branch },
    { key: "rename", label: "Rename chat", icon: PencilEdit02Icon, onSelect: run(onRename), disabled: !actions.onRename },
    {
      key: "reload",
      label: "Reload chat",
      icon: Refresh01Icon,
      hint: RELOAD_HINT,
      onSelect: run(() => actions.onReload?.(item.id)),
      disabled: !actions.onReload,
    },
    // Unlink and Link are offered on the same Worktrees (own, not shared, not the main checkout), as on the phone.
    ...(details.linkable
      ? details.linearKey
        ? [
            {
              key: "unlink-issue",
              label: "Unlink issue",
              leading: <LinearLogo size={14} />,
              onSelect: run(() => actions.onUnlinkIssue?.(item.id)),
              disabled: !actions.onUnlinkIssue,
            },
          ]
        : [{ key: "link-issue", label: "Link issue…", leading: <LinearLogo size={14} />, onSelect: run(onLink), disabled: !actions.onLinkIssue }]
      : []),
    item.unread
      ? { key: "read", label: "Mark as read", icon: Tick02Icon, onSelect: run(() => actions.onMarkUnread?.(item.id, false)), disabled: !actions.onMarkUnread }
      : {
          key: "unread",
          label: "Mark as unread",
          icon: CircleIcon,
          onSelect: run(() => actions.onMarkUnread?.(item.id, true)),
          disabled: !actions.onMarkUnread,
        },
    {
      key: "reveal",
      label: IS_MAC ? "Open in Finder" : "Open in file manager",
      icon: FolderOpenIcon,
      onSelect: run(() => actions.onReveal?.(item.id)),
      disabled: !actions.onReveal || !details.path,
    },
    {
      key: "editor",
      label: editor ? `Open in ${editor.name}` : "No editor found",
      icon: SourceCodeIcon,
      onSelect: run(() => actions.onOpenInEditor?.(item.id)),
      disabled: !editor || !actions.onOpenInEditor || !details.path,
    },
    // Every chat's folder came from `git worktree list`, so a chat with a folder is in a repository.
    {
      key: "commit",
      label: "Commit and open PR…",
      icon: GitPullRequestIcon,
      onSelect: run(() => actions.onCommit?.(item.id)),
      disabled: !actions.onCommit || !details.path,
    },
    item.pinned
      ? { key: "unpin", label: "Unpin", icon: PinOffIcon, onSelect: run(() => actions.onPin?.(item.id, null)), disabled: !actions.onPin }
      : { key: "pin", label: "Pin", icon: PinIcon, onSelect: run(() => actions.onPin?.(item.id)), disabled: !actions.onPin },
    // Canvas Links between Worktrees, offered where the chat's Worktree can take one (this Mac, not a shared Link Chat).
    ...(actions.onLinkWith && details.path
      ? [
          {
            key: "link-with",
            label: "Link with…",
            icon: Link04Icon,
            onSelect: run(() => actions.onLinkWith?.(item.id, { top: position.y, left: position.x })),
          },
        ]
      : []),
    ...(actions.onRemoveLink && linked
      ? [
          {
            key: "remove-link",
            label: "Remove Link with…",
            icon: Unlink04Icon,
            onSelect: run(() => actions.onRemoveLink?.(item.id, { top: position.y, left: position.x })),
          },
        ]
      : []),
    "divider" as const,
    ...archiveItems,
  ].filter((entry) => entry === "divider" || !actions.remote || (entry.key !== "reveal" && entry.key !== "editor"));

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(index + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      // Consumed here, so Escape doesn't also stop the open chat's turn.
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${item.label}`}
      data-chat-menu
      onKeyDown={moveFocus}
      className="fixed z-[70] rounded-[12px] bg-surface p-1.5 shadow-overlay"
      style={{ top, left: position.x, width: MENU_WIDTH, animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
    >
      <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
        {items.map((entry, index) =>
          entry === "divider" ? (
            <div key={`divider-${index}`} className="my-1 h-px bg-line" />
          ) : (
            <button
              key={entry.key}
              data-menu-row
              role="menuitem"
              type="button"
              disabled={entry.disabled}
              title={entry.hint}
              onClick={entry.onSelect}
              {...(entry.archiveChoice ? { "data-archive-choice": true } : {})}
              className={`relative z-10 flex w-full items-center gap-2 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2 disabled:opacity-40 ${entry.archiveChoice ? "min-h-8 py-1.5" : "h-8"} ${entry.danger ? "text-red" : "text-ink"}`}
            >
              <span className={`flex size-5 shrink-0 items-center justify-center ${entry.danger ? "text-red" : "text-ink-2"}`}>
                {entry.leading ?? (entry.icon && <HugeIcon icon={entry.icon} size={16} />)}
              </span>
              <span className={`min-w-0 flex-1 text-[13px] ${entry.archiveChoice ? "leading-snug" : "truncate"}`}>{entry.label}</span>
            </button>
          ),
        )}
      </GlideMenu>
      {confirm?.reason && (
        <p data-archive-reason className="px-2 pb-1 pt-1.5 text-[12px] leading-snug text-ink-3">
          {confirm.reason}
        </p>
      )}
    </div>,
    document.body,
  );
}
