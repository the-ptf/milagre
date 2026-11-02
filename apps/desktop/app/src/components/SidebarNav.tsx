import { preferenceStorage as localStorage } from "../lib/preference-storage.ts";
import { shortcutCommand, shortcutLabel, useKeybindings, chatJumpCommand } from "../lib/keybindings";
import type { NamedProjectLink } from "@milagre/shared/model";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { setBarControlsWidth, useWindowChrome } from "../lib/window-chrome";
import { ResizeHandle } from "./primitives/ResizeHandle";
import { useProjectImages } from "../lib/project-images";

import {
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  CloudOffIcon,
  Copy01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  FrameIcon,
  LaptopIcon,
  Link04Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  RepeatIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeft01Icon,
  SidebarRight01Icon,
} from "@hugeicons/core-free-icons";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { ChatRowShow } from "@milagre/shared/chat-row";
import { FiltersButton, type PickerProject } from "./sidebar/FiltersMenu";
import { thisComputer, useShortcutHints } from "../lib/shortcut-hints";
import { useEvent } from "../lib/stable";
import { ScrollArea } from "./primitives/ScrollArea";
import { projectMenuActions, type ProjectMenuKey } from "@/lib/reveal";
import { projectRows, stableOrder, type RecentProject } from "@/lib/project-list";
import { ComputersButton } from "./sidebar/ComputersButton";
import { ChatRow, type ChatRowActions, type RowComputer, type SidebarRecent } from "./sidebar/ChatRow";
import { useComputers, useHiddenComputers, isDimmed } from "../lib/computers";
import { computerAlias, computerSections, mergeScopes, useComputerScopes, withoutLocal } from "../lib/computer-scopes";
import { LOCAL_COMPUTER, computerOfKey, isLinkScopeKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { ALL_CHATS_LABEL, CHATS_GROUP_KEY, CHATS_GROUP_LABEL, type ProjectKind } from "@milagre/shared/chats-home";
import { useChatsGroup } from "../lib/project-copies";
import { gridDrop, type GridDropTarget } from "@/lib/grid-drop";
import { useDismiss } from "../lib/use-dismiss";
import { dropIntent, pinOrderAt, type DropIntent, type DropZone } from "@/lib/chat-list";
import type { ArchiveMode, ArchivePlan } from "@/lib/archive";
import { linkBetween } from "@milagre/shared/chat-links";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { preferredCopy, rememberProjectComputer } from "../lib/project-copies";
import { SidebarLinksProvider, useSidebarLinks, type LinkListHandle, type LinkScopeChats } from "./sidebar/SidebarLinks";
import { updateSettings, useSettings } from "../lib/settings";
import { UpdateSettingsBadge } from "./UpdateNotice";
import { RECENT_PROJECTS_CHANGED } from "../lib/project-list";
import { MODEL_CATALOG, type ModelOption } from "../model";
import { useBots } from "../lib/bots-store";
import { BotMarksContext, botMarks as botMarksOf, useBotMarks } from "../lib/bot-marks";
import { SidebarModeSwitch, type SidebarMode } from "./bots/SidebarModeSwitch";
import { BotList, NewBotButton } from "./bots/BotList";
import { NewBotSheet } from "./bots/NewBotSheet";
import { useRoutines } from "../lib/routines";
import {
  cachedProjectCopy,
  cachedScopeState,
  chatsSidebarRows,
  heartbeatKeys,
  heartbeatLines,
  isChatsHomeScope,
  mergeScopeChats,
  railLive,
  rememberScopeRows,
  scopeChats,
  useScopeStates,
  type ChatsGroupRow,
  type FlatChat,
  withHeartbeats,
} from "../lib/sidebar-scopes";
import { ScopeRail, type RailScope } from "./sidebar/ScopeRail";
import { bridgeFor, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { DoneSection, type DoneEntry } from "./sidebar/DoneSection";
import { SidebarToast } from "./sidebar/SidebarToast";
import { undoHistory, type UndoAction } from "../lib/undo-history";
import { DELETE_UNDO_MS } from "@milagre/shared/archive";
import { useDoneSettings } from "../lib/done-settings";
import { patchChatShowingDone, settleDonePending, useDonePending, withDonePending } from "../lib/done-pending";
import { OpenSubchatContext, jumpChatRows, rowKeys, shownChats, useSubchatFolds, type ShownRow } from "../lib/subchat-rows";

type HugeIconProps = { size?: number; className?: string };
type HugeIconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function HugeIcon({ icon, size = 16, className }: HugeIconProps & { icon: HugeIconData }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" className={className} />;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
const PROJECT_MENU_ICONS: Record<ProjectMenuKey, HugeIconData> = {
  reveal: FolderOpenIcon,
  "copy-path": Copy01Icon,
  "copy-name": Copy01Icon,
  settings: Settings01Icon,
};

const IconChevronDownSmall = (props: HugeIconProps) => <HugeIcon icon={ArrowDown01Icon} {...props} />;
const IconFolderAdd = (props: HugeIconProps) => <HugeIcon icon={FolderAddIcon} {...props} />;
const IconMagnifyingGlass = (props: HugeIconProps) => <HugeIcon icon={Search01Icon} {...props} />;
const IconPlusMedium = (props: HugeIconProps) => <HugeIcon icon={Add01Icon} {...props} />;
const IconSettingsGear1 = (props: HugeIconProps) => <HugeIcon icon={Settings01Icon} {...props} />;

/* ─────────────────────────────────────────────────────────
 * SIDEBAR NAV
 * Shared by the design-system preview and the harness shell.
 * Every Project and Link listed with its chats, then primary
 * navigation, searchable chat history, and a collapse that
 * preserves icon alignment.
 * ───────────────────────────────────────────────────────── */

const WORKSPACE = { key: "creamery", name: "Creamery Ops", monogram: "C" };

const DEFAULT_RECENTS: SidebarRecent[] = [
  { id: "suppliers", label: "Supplier records" },
  { id: "todos", label: "Urgent to-dos this morning" },
  { id: "flavor", label: "Flavor page ticket" },
  { id: "workload", label: "Workload summary" },
  { id: "offboarding", label: "Off-board a supplier" },
  { id: "restock", label: "Batch restock function" },
  { id: "edits", label: "Propose flavor edits" },
  { id: "subway", label: "Subway surfing" },
];

type SidebarNavProps = {
  selectedLink?: { id: string; projects: Array<{ path: string; name: string }> };
  onSwitchLink?: (id: string) => void;
  onLinkProject?: () => void;
  /** Opens Add computer. */
  onAddComputer?: () => void;
  /** Opens a computer's settings; null for This Mac (Settings › Devices). */
  onOpenComputerSettings?: (id: string | null) => void;
  /** Opens the dialog that renames a Link or changes its member Projects. */
  onEditLink?: (id: string) => void;
  workspaceName?: string;
  workspaceImage?: string | null;
  /** Runs the folder dialog. */
  onOpenProject?: () => void;
  activeTitle?: string | null;
  /** Controlled selection of a recent by id; takes precedence over title matching. */
  activeId?: string | null;
  className?: string;
  fill?: boolean;
  onNewChat?: () => void;
  /** The open scope's own header +: a Link's starts a Link Chat while New chat elsewhere starts on this Mac. Defaults to `onNewChat`. */
  onNewCurrentScopeChat?: () => void;
  onPick?: (id: string, label: string, prompt?: string) => void;
  /** Current scope shortcut targets, in this sidebar mode's visible order. */
  onJumpChatsChange?: (ids: string[]) => void;
  onOpenSettings?: () => void;
  onOpenCanvas?: () => void;
  canvasActive?: boolean;
  /** Opens the Routines page; its button sits between Search and Filters. */
  onOpenRoutines?: () => void;
  routinesActive?: boolean;
  /** Projects or Bots; the switch shows only while Bots is on (Settings › Experimental) and this is given. */
  sidebarMode?: SidebarMode;
  onSidebarMode?: (mode: SidebarMode) => void;
  selectedBotId?: string | null;
  onPickBot?: (id: string) => void;
  /** The models New bot offers, and the one it starts on. */
  models?: ModelOption[];
  defaultModel?: ModelOption;
  /** A hidden Run Chat is unread: the Routines button shows a dot. */
  routinesUnread?: boolean;
  onOpenCommands?: () => void;
  hintsEnabled?: boolean;
  /** The project folder, for the project menu's reveal and copy path. */
  projectPath?: string;
  /** "chats" when `projectPath` is a Chats home: its Chats list in the Chats group, never as a Project. */
  projectKind?: ProjectKind;
  /** The Chats group's +: a new Chat without a Project on this Mac. */
  onNewChatWithoutProject?: () => void;
  /** Opens a project from the recent list in the project menu. */
  onSwitchProject?: (path: string) => void;
  /** Other projects with a chat that waits on the user: their rows and the project button get a dot. */
  attentionPaths?: string[];
  /** Opens a Project's settings, by its path. */
  onOpenProjectSettings?: (path: string) => void;
  /** Starts a new chat in another Project (its path) or Link (`milagre-link:` key), switching to it first. */
  onNewChatInScope?: (scopeKey: string) => void;
  recents?: SidebarRecent[];
  /** What the chat rows' menu can do; an action left out is shown disabled. */
  chatActions?: ChatRowActions;
  /** Actions bound to the row's own scope, independent of the draft or Chat on screen. */
  scopeChatActions?: (scopeKey: string, gitless: boolean) => ChatRowActions;
  /** Plan usage, shown above the footer buttons in both the expanded and collapsed sidebar. */
  usage?: ReactNode;
  variant?: string;
  /** Chat keys with a turn streaming, and with one waiting on the user, joined by newlines (one string keeps memo cheap). */
  runningKeys?: string;
  waitingKeys?: string;
  /** Of those waiting, the chats whose next card is a question. */
  askingKeys?: string;
  /** Opens a chat of another Project (its path) or Link (`milagre-link:` key) from the all-Projects sidebar. */
  onOpenScopeChat?: (scopeKey: string, id: string) => void;
  /** Archive for another Project's rows (by its path): what the confirm step offers, then the archive itself. */
  onScopeArchiveCheck?: (scopeKey: string, id: string) => Promise<ArchivePlan>;
  /** `chatsHome`: the row is a Chat without a Project (the Chats group's). */
  onScopeArchive?: (scopeKey: string, id: string, mode: ArchiveMode, plan: ArchivePlan) => Promise<unknown>;
  /** Chats with an archive under way, by `projectPath#id`: their rows are gone at once, before the host answers. */
  archivingChats?: ReadonlySet<string>;
  /** The pointer rests on a chat's row: its page can be read before the click. */
  onHoverChat?: (scopeKey: string, id: string) => void;
  /** "Link and ask A…": sends the message to that chat (its Project path and id) through the normal send path. */
  onAskChat?: (scopeKey: string, id: string, message: { body: string; prompt: string }) => Promise<unknown>;
};

const NO_CHAT_ACTIONS: ChatRowActions = {};
const NEVER_ACTIVE = () => false;
// A subchat that waits on the user (a question or an approval) turns its family's badge orange.
const subchatAsks = (row: Pick<SidebarRecent, "mark">) => row.mark === "question" || row.mark === "waiting";

// Groups of the all-Projects sidebar the user folded, by Project path or Link key; the rest stay open.
const CLOSED_SCOPES_KEY = "milagre.sidebarClosedScopes";
function readClosedScopes(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_SCOPES_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// The Projects' group order in the all-Projects sidebar, so a restart or a new window keeps it (see stableOrder).
const SCOPE_ORDER_KEY = "milagre.sidebarScopeOrder";
// What this window last read from or wrote to storage. Another window may have saved a newer order since, so a window
// writes only when its own order differs from this: a re-render with an unchanged order never puts an old one back.
let syncedScopeOrder = "";
function readScopeOrder(): string[] {
  try {
    const raw = localStorage.getItem(SCOPE_ORDER_KEY) ?? "[]";
    const saved = JSON.parse(raw);
    const order = Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    syncedScopeOrder = JSON.stringify(order);
    return order;
  } catch {
    return [];
  }
}
function writeScopeOrder(order: string[]) {
  try {
    const next = JSON.stringify(order);
    if (next === syncedScopeOrder) return;
    syncedScopeOrder = next;
    localStorage.setItem(SCOPE_ORDER_KEY, next);
  } catch {
    // Storage full or blocked: the order lasts for this session only.
  }
}

type ScopeMenuItem = {
  key: string;
  label: string;
  icon: HugeIconData;
  run: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
};

/** The keys the sidebar's hints show, as this Mac's keybindings have them. */
function useSidebarKeys() {
  const { rules } = useKeybindings();
  return {
    newChat: shortcutLabel(rules, "chat.new"),
    sidebar: shortcutLabel(rules, "sidebar.toggle"),
    search: shortcutLabel(rules, "commandPalette.toggle"),
    addProject: shortcutLabel(rules, "project.add"),
    settings: shortcutLabel(rules, "settings.open"),
    jump: (index: number) => shortcutLabel(rules, chatJumpCommand(index)),
  };
}

/** A Project or Link heading in the sidebar: folds its chats. Hovered, the chevron takes the icon's place, as in Paseo; the ⋯ menu and the + sit on the right. */
function ScopeHeader({
  name,
  icon,
  open,
  current,
  plusIsCurrent = current,
  attention,
  computer,
  onToggle,
  onNewChat,
  menu,
}: {
  name: string;
  icon: ReactNode;
  open: boolean;
  current: boolean;
  /** Whether the + is the open scope's own (⌘N); defaults to `current`. */
  plusIsCurrent?: boolean;
  attention: boolean;
  /** The computer the Project or Link lives on, once there are two or more: a chip with its short name, the full one in
   * a tooltip. Its rows then leave it out. */
  computer?: RowComputer;
  onToggle: () => void;
  /** None hides the +. */
  onNewChat?: () => void;
  /** The ⋯ menu's rows; none hides the button. */
  menu: ScopeMenuItem[];
}) {
  const keys = useSidebarKeys();
  // Room on the right for what shows there, so the name (and the computer chip) reach the edge: the attention dot, and
  // on hover the ⋯ and + with the dot slid left of them.
  const rightRoom = `${attention ? "pr-6" : "pr-2"} ${
    attention
      ? menu.length > 0
        ? "group-hover/scope:pr-[80px] group-has-[:focus-visible]/scope:pr-[80px]"
        : "group-hover/scope:pr-[52px] group-has-[:focus-visible]/scope:pr-[52px]"
      : menu.length > 0
        ? "group-hover/scope:pr-[60px] group-has-[:focus-visible]/scope:pr-[60px]"
        : "group-hover/scope:pr-8 group-has-[:focus-visible]/scope:pr-8"
  }`;
  return (
    <div className="group/scope relative mx-2 flex h-8 items-center">
      <button
        type="button"
        data-scope-toggle
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}${computer ? ` on ${computer.name}${computer.offline ? ", offline" : ""}` : ""}`}
        onClick={onToggle}
        className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] pl-2 text-left hover:bg-hover-2 ${rightRoom}`}
      >
        {/* A Link's stacked avatars are wider than a Project's icon, so the slot grows with them. */}
        <span className="relative flex h-5 min-w-5 shrink-0 items-center justify-center text-ink">
          <span className="flex items-center justify-center transition-opacity duration-100 group-hover/scope:opacity-0 group-has-[[data-scope-toggle]:focus-visible]/scope:opacity-0">
            {icon}
          </span>
          <span
            aria-hidden
            data-scope-chevron
            className={`absolute inset-y-0 left-0 flex w-5 items-center justify-center text-ink-3 opacity-0 transition-[opacity,transform] duration-150 group-hover/scope:opacity-100 group-has-[[data-scope-toggle]:focus-visible]/scope:opacity-100 ${open ? "" : "-rotate-90"}`}
          >
            <IconChevronDownSmall size={14} />
          </span>
        </span>
        <span
          data-scope-name
          className={`min-w-0 flex-1 truncate text-[length:calc(13px+var(--sidebar-delta))] ${current ? "font-medium text-ink" : "text-ink-2"}`}
        >
          {name}
        </span>
        {/* Never shrinks: a long Project name gives way first. */}
        {computer && (
          <Tooltip
            label={computer.offline ? `${computer.name}, offline` : computer.local ? `${computer.name} · ${thisComputer}` : computer.name}
            align="end"
            className="shrink-0"
          >
            <span
              data-scope-computer
              data-offline={computer.offline || undefined}
              className={`flex h-[18px] items-center gap-1 rounded-[5px] px-1.5 text-[length:calc(11px+var(--sidebar-delta))] font-medium ${computer.offline ? "bg-orange-tint text-orange-ink" : "bg-ink/[0.07] text-ink-2"}`}
            >
              <HugeIcon icon={computer.offline ? CloudOffIcon : LaptopIcon} size={11} />
              <span className="max-w-[72px] truncate">{computerAlias(computer.name)}</span>
            </span>
          </Tooltip>
        )}
      </button>
      {/* Rests at the right edge; slides left when hover reveals the actions it would sit under. */}
      {attention && (
        <AttentionDot
          className={`pointer-events-none absolute right-3 transition-transform duration-150 ease-out ${menu.length > 0 ? "group-hover/scope:-translate-x-[52px] group-has-[:focus-visible]/scope:-translate-x-[52px]" : "group-hover/scope:-translate-x-[26px] group-has-[:focus-visible]/scope:-translate-x-[26px]"}`}
        />
      )}
      <div className="absolute right-1 flex items-center gap-0.5">
        {menu.length > 0 && <ScopeMenuButton name={name} items={menu} />}
        {onNewChat && (
          <Tooltip label="New chat" shortcut={plusIsCurrent ? keys.newChat : undefined} align="end">
            <button
              type="button"
              data-scope-action
              aria-label={plusIsCurrent ? "New chat" : `New chat in ${name}`}
              onClick={onNewChat}
              className={`${SCOPE_HEADER_BUTTON} opacity-0 group-hover/scope:opacity-100 focus-visible:opacity-100`}
            >
              <IconPlusMedium size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** A Project's or Link's ⋯ button; its rows open in a panel on the body, under the button. */
function ScopeMenuButton({ name, items }: { name: string; items: ScopeMenuItem[] }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    // Right-aligned to the button, but never past the window's left edge in a narrow sidebar.
    setPosition({ top: rect.bottom + 4, left: Math.max(8, rect.right - 224) });
    return true;
  };
  const close = () => setOpen(false);
  const openMenu = () => {
    if (place()) setOpen(true);
  };

  useDismiss(open, close, (target) => !!target.closest("[data-scope-menu], [data-scope-menu-panel]"), place);
  useLayoutEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("[data-menu-row]:not(:disabled)")?.focus();
  }, [open]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(index + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  return (
    <>
      <Tooltip label="More" align="end">
        <button
          ref={buttonRef}
          type="button"
          data-scope-menu
          aria-label={`${name} actions`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (open ? close() : openMenu())}
          className={`${SCOPE_HEADER_BUTTON} ${open ? "opacity-100" : "opacity-0 group-hover/scope:opacity-100 focus-visible:opacity-100"}`}
        >
          <HugeIcon icon={MoreVerticalIcon} size={14} />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={`${name} actions`}
            onKeyDown={moveFocus}
            data-scope-menu-panel
            className="fixed z-50 flex max-h-[calc(100vh-16px)] w-56 flex-col overflow-hidden rounded-[14px] bg-surface shadow-overlay"
            style={{
              top: position.top,
              left: position.left,
              animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: "top right",
            }}
          >
            <ScrollArea className="p-1.5">
              <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
                {items.map((item) => (
                  <Fragment key={item.key}>
                    {item.separatorBefore && <div className="my-1 h-px bg-line" />}
                    <button
                      data-menu-row
                      data-scope-menu-item={item.key}
                      role="menuitem"
                      type="button"
                      disabled={item.disabled}
                      onClick={() => {
                        close();
                        item.run();
                      }}
                      className="relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2 disabled:opacity-40"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
                        <HugeIcon icon={item.icon} size={16} />
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-[13.5px] ${item.destructive ? "text-red-ink" : "text-ink"}`}>{item.label}</span>
                    </button>
                  </Fragment>
                ))}
              </GlideMenu>
            </ScrollArea>
          </div>,
          document.body,
        )}
    </>
  );
}

const NO_PATHS: string[] = [];
// Project and Link workspaces draw the same list in separate DOM trees.
const scrollPositions = new Map<string, number>();
// The last lists and group order any sidebar loaded. A switch between a Project and a Link mounts the other sidebar,
// which starts from these instead of empty, so its Links and groups don't blink while it reads them again.
const lastLists = {
  links: [] as NamedProjectLink[],
  registered: [] as Array<{ id: string; name: string; path: string }>,
  recent: [] as RecentProject[],
  recentLoaded: false,
  // Null until the first sidebar of this window reads the saved order.
  order: null as string[] | null,
};

/** A Link as the last sidebar read it, with its member Projects: enough to open it at once while the host answers. */
export function knownLink(id: string): { link: NamedProjectLink; projects: Array<{ id: string; name: string; path: string }> } | null {
  const link = lastLists.links.find((item) => item.id === id);
  if (!link) return null;
  const projects = link.projectIds.map(
    (projectId) =>
      lastLists.registered.find((project) => project.id === projectId) ?? {
        id: projectId,
        name: projectId.split(/[\\/]/).filter(Boolean).at(-2) ?? projectId,
        path: "",
      },
  );
  return { link, projects };
}

function AttentionDot({ className = "" }: { className?: string }) {
  return <span role="img" aria-label="Needs attention" title="A chat here waits for you" className={`size-2 shrink-0 rounded-full bg-orange ${className}`} />;
}

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  // A 32px control with 6px of space on each side.
  collapsedWidth: 44,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

// Dragging the sidebar's right edge widens it between these bounds; the width survives restarts.
const SIDEBAR_MIN_WIDTH = SIDEBAR_MOTION.expandedWidth;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = "milagre.sidebarWidth";

const clampSidebarWidth = (width: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));

function readSidebarWidth() {
  const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_MIN_WIDTH;
}

// Narrower than this, the sidebar collapses on its own so the chat keeps its room. It can still be expanded.
const AUTO_COLLAPSE_QUERY = "(max-width: 1024px)";

// The + and ⋯ on a Project's header: smaller than the row, so their hover fill doesn't read as a second row.
const SCOPE_HEADER_BUTTON =
  "flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]";

const CHATS_HEADER_BUTTON =
  "flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]";

const TOOL_BUTTON = "flex h-8 items-center justify-center gap-1.5 rounded-[8px] px-2 text-[13px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink";
const BOTTOM_BAR_BUTTON =
  "flex items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]";

export function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu rowSelector="[data-row]" highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2" className="group/glide flex flex-col gap-px">
      {children}
    </GlideMenu>
  );
}

export function RailButton({
  icon,
  label,
  active = false,
  count,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: string;
  onClick?: () => void;
}) {
  return (
    <button
      data-row
      type="button"
      onClick={onClick}
      className={`sidebar-row relative z-10 mx-2 flex h-9 items-center rounded-[8px] px-2 text-left
        transition-[width,background-color,color,transform] duration-150 active:scale-[0.98]
        ${active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center ${active ? "text-ink" : "text-ink-2"}`}>{icon}</span>
      <span
        className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[length:calc(15px+var(--sidebar-delta))] font-medium ${active ? "text-ink" : "text-ink-2"}`}
      >
        {label}
      </span>
      {count && <span className="sidebar-copy mr-2 shrink-0 text-[length:calc(12px+var(--sidebar-delta))] font-medium tabular-nums text-ink-3">{count}</span>}
    </button>
  );
}

// memo: App rebuilds on every streamed batch and keystroke elsewhere; the sidebar only follows its own props.
export default memo(function SidebarNav({
  workspaceName = WORKSPACE.name,
  workspaceImage,
  selectedLink,
  onLinkProject,
  onAddComputer,
  onOpenComputerSettings,
  onEditLink,
  onOpenProject,
  onSwitchLink,
  onSwitchProject,
  activeTitle,
  activeId,
  className = "",
  fill = false,
  onNewChat,
  onNewCurrentScopeChat,
  onPick,
  onJumpChatsChange,
  onOpenSettings,
  onOpenCanvas,
  canvasActive = false,
  onOpenRoutines,
  routinesActive = false,
  sidebarMode = "projects",
  onSidebarMode,
  selectedBotId = null,
  onPickBot,
  models = MODEL_CATALOG,
  defaultModel,
  routinesUnread = false,
  onOpenCommands,
  hintsEnabled = true,
  projectPath,
  projectKind,
  onNewChatWithoutProject,
  onOpenProjectSettings,
  attentionPaths = NO_PATHS,
  recents: hostRecents = DEFAULT_RECENTS,
  chatActions = NO_CHAT_ACTIONS,
  scopeChatActions,
  usage,
  runningKeys = "",
  waitingKeys = "",
  askingKeys = "",
  onOpenScopeChat,
  onScopeArchiveCheck,
  onScopeArchive,
  archivingChats,
  onHoverChat,
  onNewChatInScope,
  onAskChat,
}: SidebarNavProps) {
  const keys = useSidebarKeys();
  const currentKey = selectedLink ? `milagre-link:${selectedLink.id}` : (projectPath ?? "");
  // A Chat marked Done or reopened moves at once; its host's rows catch up (done-pending.ts).
  const donePending = useDonePending();
  const listedRecents = useMemo(() => withDonePending(currentKey, hostRecents, donePending), [currentKey, hostRecents, donePending]);
  // Done chats leave the open scope's list for the Done section at the bottom (DoneSection).
  const recents = useMemo(() => (listedRecents.some((row) => row.doneAt) ? listedRecents.filter((row) => !row.doneAt) : listedRecents), [listedRecents]);
  const { settings: doneSettings } = useDoneSettings();
  const { chatOrder, chatRowShow, chatList } = useSettings();
  // Other computers (Settings › Devices): their Projects join the list, and every row says its computer.
  const { thisMac, computers } = useComputers();
  const remote = useComputerScopes(computers);
  const multi = computers.length > 0;
  // Computers unchecked in the computers popover: the sidebar leaves out their Projects, all but the open one.
  const hiddenComputers = useHiddenComputers();
  const remoteScopes = remote.scopes.filter((scope) => !hiddenComputers.has(scope.computerId));
  // Each computer's Chats home (not off or hidden): its Chats make the Chats group, and it is never listed as a Project.
  const homeCopies = useChatsGroup(true)?.copies;
  const homeKeys = useMemo(() => new Set(homeCopies?.map((home) => home.key)), [homeCopies]);
  const isHome = (key: string) => isChatsHomeScope(key, { currentKey: projectPath ?? "", currentKind: projectKind, homeKeys });
  // One object per computer and state, so memo'd rows keep their props.
  const rowComputers = useRef(new Map<string, RowComputer>());
  const rowComputer = (key: string): RowComputer | undefined => {
    if (!multi) return undefined;
    const id = computerOfKey(key);
    const view = computers.find((computer) => computer.id === id);
    const name = id === LOCAL_COMPUTER ? thisMac : (view?.name ?? "Computer");
    const offline = id !== LOCAL_COMPUTER && isDimmed(view);
    const cacheKey = `${id}\n${name}\n${offline}`;
    let made = rowComputers.current.get(cacheKey);
    if (!made) rowComputers.current.set(cacheKey, (made = { name, offline, local: id === LOCAL_COMPUTER }));
    return made;
  };
  const scrollRef = useRef<HTMLElement>(null);
  const scrollKey = `${chatList}:${sidebarMode}`;
  const restoreScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    restoreScroll.current = scrollPositions.get(scrollKey) ?? 0;
  }, [scrollKey]);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const top = restoreScroll.current;
    if (!node || top === null) return;
    // The scope-state hooks can still be restoring their rows in this layout pass. Keep the target until they fit.
    node.scrollTop = top;
    if (node.scrollTop === top) {
      restoreScroll.current = null;
      return;
    }
    // If Chats were removed while this workspace was hidden, accept the new end after the layout settles.
    const frame = window.requestAnimationFrame(() => {
      restoreScroll.current = null;
      scrollPositions.set(scrollKey, node.scrollTop);
    });
    return () => window.cancelAnimationFrame(frame);
  });
  const [listsChanged, setListsChanged] = useState(0);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(AUTO_COLLAPSE_QUERY).matches);
  const subchatFolds = useSubchatFolds();
  const jumpIds = useMemo(
    () => jumpChatRows(recents, currentKey, subchatFolds, collapsed).map((row) => row.id),
    [recents, currentKey, subchatFolds, collapsed],
  );
  useLayoutEffect(() => {
    onJumpChatsChange?.(jumpIds);
  }, [jumpIds, onJumpChatsChange]);
  // True only while the sidebar is collapsed because the window got narrow, so widening it brings the sidebar back.
  const autoCollapsed = useRef(collapsed);
  const [expandedWidth, setExpandedWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [demoActiveTitle, setDemoActiveTitle] = useState<string | null>(null);
  const [namedLinks, setNamedLinks] = useState(() => lastLists.links);
  const [registeredProjects, setRegisteredProjects] = useState(() => lastLists.registered);
  const [recentProjects, setRecentProjects] = useState(() => lastLists.recent);
  const [recentLoaded, setRecentLoaded] = useState(() => lastLists.recentLoaded);
  // The Projects' group order, saved across restarts and windows; see stableOrder.
  const scopeOrder = useRef<string[]>(lastLists.order ?? readScopeOrder());
  const showHints = useShortcutHints() && hintsEnabled;
  const bots = useBots();
  const botsOn = bots.enabled && onSidebarMode !== undefined;
  const botsMode = botsOn && sidebarMode === "bots";
  const botMarks = useMemo(() => botMarksOf(bots.snapshot), [bots.snapshot]);
  const [newBotOpen, setNewBotOpen] = useState(false);

  const selectedTitle = activeTitle === undefined ? demoActiveTitle : activeTitle;
  // One identity for every row, so memo(ChatRow) skips when the sidebar re-renders.
  const pickChat = useCallback(
    (item: SidebarRecent) => {
      if (activeTitle === undefined) setDemoActiveTitle(item.label);
      onPick?.(item.id, item.label, item.prompt);
    },
    [activeTitle, onPick],
  );
  const workspace = { name: workspaceName, image: workspaceImage, monogram: workspaceName.trim().slice(0, 1).toUpperCase() || "M" };
  const projects = projectPath
    ? projectRows({ recent: recentProjects, currentPath: projectPath, currentName: workspaceName })
    : recentProjects.map((project) => ({ ...project, initial: project.name.slice(0, 1).toUpperCase(), current: false }));

  // A sidebar whose effects run again after a hidden spell (the Project's behind a Link, an <Activity>) first takes
  // what the other sidebar read meanwhile, before paint, so a Link made while it was away is listed at once.
  const readBefore = useRef(false);
  useLayoutEffect(() => {
    // Taken now: this sidebar's own effect below writes its stale lists over the cache right after.
    const { links, registered, recent, recentLoaded, order } = lastLists;
    if (readBefore.current) {
      setNamedLinks(links);
      setRegisteredProjects(registered);
      setRecentProjects(recent);
      setRecentLoaded(recentLoaded);
      if (order) scopeOrder.current = order;
    }
    readBefore.current = true;
  }, []);
  // Read on mount and again each time the menu opens, so a folder that's gone drops out.
  useEffect(() => {
    let live = true;
    window.milagre?.listRecentProjects?.().then(
      (list) => {
        if (live) {
          setRecentProjects(Array.isArray(list) ? list : []);
          setRecentLoaded(true);
        }
      },
      () => {},
    );
    void window.milagre
      ?.listNamedLinks?.()
      .then((links) => {
        if (live) setNamedLinks(Array.isArray(links) ? links : []);
      })
      .catch(() => {});
    void window.milagre
      ?.listProjects?.()
      .then((projects) => {
        if (live) setRegisteredProjects(Array.isArray(projects) ? projects : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, selectedLink?.id, listsChanged]);
  useEffect(() => {
    const changed = () => setListsChanged((count) => count + 1);
    window.addEventListener(RECENT_PROJECTS_CHANGED, changed);
    const stopLocalMcp = bridgeFor(LOCAL_COMPUTER).localMcp?.onChanged?.((payload) => {
      if (payload?.projectAdded) window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    });
    return () => {
      window.removeEventListener(RECENT_PROJECTS_CHANGED, changed);
      stopLocalMcp?.();
    };
  }, []);
  // Another window saved a new group order: follow it.
  const [, setOrderSynced] = useState(0);
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key !== SCOPE_ORDER_KEY) return;
      scopeOrder.current = readScopeOrder();
      setOrderSynced((count) => count + 1);
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, []);

  // Every recent Project the user didn't hide, then every Link, like the phone's list. The open one is always there.
  const projectScopes = projects
    .filter((row) => !isHome(row.path))
    .filter((row) => row.current || (!recentProjects.find((project) => project.path === row.path)?.hidden && !hiddenComputers.has(computerOfKey(row.path))))
    .map((row) => ({
      key: row.path,
      name: row.name,
      initial: row.initial,
      link: null as NamedProjectLink | null,
      computerId: computerOfKey(row.path),
      origin: recentProjects.find((project) => project.path === row.path)?.origin,
    }));
  if (recentLoaded)
    scopeOrder.current = stableOrder(
      scopeOrder.current,
      projectScopes.map((scope) => scope.key),
    );
  const orderedProjects = recentLoaded ? scopeOrder.current.map((key) => projectScopes.find((scope) => scope.key === key)!).filter(Boolean) : projectScopes;
  // The next sidebar to mount (a Link's, or the Project one again) starts from what this one has.
  useEffect(() => {
    Object.assign(lastLists, { links: namedLinks, registered: registeredProjects, recent: recentProjects, recentLoaded, order: scopeOrder.current });
    // Saved only once the recent list has loaded, so the empty list before that doesn't wipe it.
    if (recentLoaded) writeScopeOrder(scopeOrder.current);
  });
  const localScopes = [
    ...orderedProjects,
    ...namedLinks
      .filter((link) => link.id === selectedLink?.id || (!link.hidden && !hiddenComputers.has(LOCAL_COMPUTER)))
      .map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId: LOCAL_COMPUTER, origin: undefined })),
  ];
  // With other computers, one list by name (their order can't follow this Mac's open history); with this Mac alone, as before.
  const scopes = multi
    ? mergeScopes(
        // The open Project of another computer is already among the local ones, under its qualified key.
        [...localScopes, ...withoutLocal(remoteScopes, localScopes).filter((scope) => !isHome(scope.key))],
        computers.map((computer) => computer.id),
      )
    : localScopes;
  // Every Project, hidden ones too, since the project chooser lists them all.
  const scopeImage = useProjectImages([
    ...projects.map((row) => row.path),
    ...registeredProjects.map((project) => project.path),
    ...remote.scopes.filter((scope) => !scope.link).map((scope) => scope.key),
  ]);
  const showAll = !collapsed;
  // One list: every scope's chats in one column, each row naming its Project; Grouped by Project keeps a fold per scope.
  // With no selected scope, keep even Projects and Links without Chats available to choose.
  const oneList = chatList === "list" && !!currentKey;
  // The Chats group's homes: the open one, then each computer's that exists or that this window has a state of (one
  // made since its home was read). Only those that exist are read.
  const openHome = projectKind === "chats" && projectPath ? projectPath : undefined;
  const homeScopes = [
    ...(openHome ? [openHome] : []),
    ...(homeCopies ?? [])
      .filter((home) => home.key !== openHome && (home.exists || cachedScopeState(home.key) || cachedProjectCopy(home.key)))
      .map((home) => home.key),
  ];
  const {
    states: scopeStates,
    failed: failedScopes,
    retry: retryScope,
  } = useScopeStates(
    // Collapsed too: the rail's icons show each scope's chats' state and list the live ones.
    true,
    [...scopes.map((scope) => scope.key), ...homeScopes].filter((key) => key !== currentKey),
  );
  // The open scope's rows carry facts read for it alone (PRs, Linear issues, ports); its rows keep them once another
  // scope is open, so switching doesn't shrink them.
  useEffect(() => rememberScopeRows(currentKey, recents), [currentKey, recents]);
  const marks = useMemo(
    () => ({
      running: new Set(runningKeys.split("\n").filter(Boolean)),
      waiting: new Set(waitingKeys.split("\n").filter(Boolean)),
      asking: new Set(askingKeys.split("\n").filter(Boolean)),
    }),
    [runningKeys, waitingKeys, askingKeys],
  );
  // Chats an enabled heartbeat checks back on carry a pulse. The sidebar listens to Routines itself, so a Routine change
  // re-renders it alone, not the App and its open Chat.
  const { routines } = useRoutines();
  const beatKeys = useMemo(() => heartbeatKeys(routines), [routines]);
  const beats = useMemo(() => heartbeatLines(beatKeys), [beatKeys]);
  // Per scope, the marked rows last built: the same rows and heartbeats give the same list, so ChatRow's memo holds.
  const markedRows = useRef(new Map<string, { rows: SidebarRecent[]; keys: string; marked: SidebarRecent[] }>());
  const withBeats = (scopeKey: string, rows: SidebarRecent[]) => {
    const hit = markedRows.current.get(scopeKey);
    if (hit && hit.rows === rows && hit.keys === beatKeys) return hit.marked;
    const marked = withHeartbeats(scopeKey, rows, beats);
    markedRows.current.set(scopeKey, { rows, keys: beatKeys, marked });
    return marked;
  };
  // Another Project's or Link's chats can be pinned from here, and a Project's archived; the row menu's other actions
  // stay with the open one. One object per scope, so its rows keep their memo. A Chats home's rows are `gitless`: no
  // branch to copy, no PR to open.
  const scopeActions = useRef(new Map<string, ChatRowActions>());
  const scopeArchive = useRef({ check: onScopeArchiveCheck, archive: onScopeArchive });
  scopeArchive.current = { check: onScopeArchiveCheck, archive: onScopeArchive };
  const actionsFor = (key: string, gitless = false) => {
    const cacheKey = gitless ? `gitless\n${key}` : key;
    let actions = scopeActions.current.get(cacheKey);
    if (!actions) {
      const archivable = !key.startsWith("milagre-link:") && !!onScopeArchiveCheck && !!onScopeArchive;
      actions = {
        ...scopeChatActions?.(key, gitless),
        remote: isRemoteKey(key),
        ...(gitless ? { gitless: true } : {}),
        onPin: (id, order) =>
          void bridgeForKey(key)
            .patchChat(key, Number(id), order == null ? { pinned: false, pin_order: undefined } : { pinned: true, pin_order: order })
            .catch(() => {}),
        onDone: (id) => void patchChatShowingDone(key, Number(id), { done: true, unread: false }).catch(() => {}),
        onReopen: (id) => void patchChatShowingDone(key, Number(id), { done: false }).catch(() => {}),
        ...(archivable
          ? {
              onArchiveCheck: (id: string) => scopeArchive.current.check!(key, id),
              onArchive: (id: string, mode: ArchiveMode, plan: ArchivePlan) => scopeArchive.current.archive!(key, id, mode, plan),
            }
          : {}),
      };
      scopeActions.current.set(cacheKey, actions);
    }
    return actions;
  };
  const scopePickers = useRef(new Map<string, (item: SidebarRecent) => void>());
  const pickerFor = (key: string) => {
    let pick = scopePickers.current.get(key);
    if (!pick) {
      pick = (item) => openScope.current(key, item.id);
      scopePickers.current.set(key, pick);
    }
    return pick;
  };
  const openScope = useRef((key: string, id: string) => onOpenScopeChat?.(key, id));
  openScope.current = (key: string, id: string) => onOpenScopeChat?.(key, id);
  const hoverScope = useRef((key: string, id: string) => onHoverChat?.(key, id));
  hoverScope.current = (key: string, id: string) => onHoverChat?.(key, id);
  const scopeHovers = useRef(new Map<string, (item: SidebarRecent) => void>());
  const hoverFor = (key: string) => {
    let hover = scopeHovers.current.get(key);
    if (!hover) {
      hover = (item) => hoverScope.current(key, item.id);
      scopeHovers.current.set(key, hover);
    }
    return hover;
  };
  // Each scope's rows as its host sent them, so the pending Done marks they already agree with are dropped after render.
  const hostRows: [string, SidebarRecent[]][] = [[currentKey, hostRecents]];
  const pendingDone = (key: string, rows: SidebarRecent[]) => {
    hostRows.push([key, rows]);
    return withDonePending(key, rows, donePending);
  };
  useEffect(() => {
    if (donePending.size) for (const [key, rows] of hostRows) settleDonePending(key, rows);
  });
  const unarchived = (key: string, rows: SidebarRecent[]) => (archivingChats?.size ? rows.filter((row) => !archivingChats.has(`${key}#${row.id}`)) : rows);
  const withoutDone = (rows: SidebarRecent[]) => (rows.some((row) => row.doneAt) ? rows.filter((row) => !row.doneAt) : rows);
  // Canvas Links join this Mac's Projects: a Named Link's shared chats and another computer's take none.
  const linkProjectIdOf = (key: string | undefined) =>
    key && !key.startsWith("milagre-link:") && !isRemoteKey(key) ? (registeredProjects.find((project) => project.path === key)?.id ?? null) : null;
  const buildGroups = showAll || oneList;
  const groups = buildGroups
    ? scopes.map((scope) => {
        const current = scope.key === currentKey;
        // The Project just left has no read of its own yet; the copy it was shown from fills in until one arrives.
        const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
        const all = withBeats(
          scope.key,
          current ? listedRecents : state ? unarchived(scope.key, pendingDone(scope.key, scopeChats(scope.key, state, chatOrder, marks))) : [],
        );
        const rows = withoutDone(all);
        const list = current
          ? {
              isActive: (item: SidebarRecent) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle),
              collapsed: false,
              actions: chatActions,
              showHints,
              onPick: pickChat,
              onHover: hoverFor(scope.key),
              linkProjectId: scope.link ? null : linkProjectIdOf(scope.key),
              computer: rowComputer(scope.key),
              show: chatRowShow,
            }
          : {
              isActive: NEVER_ACTIVE,
              collapsed: false,
              actions: actionsFor(scope.key),
              showHints: false,
              onPick: pickerFor(scope.key),
              onHover: hoverFor(scope.key),
              linkProjectId: scope.link ? null : linkProjectIdOf(scope.key),
              computer: rowComputer(scope.key),
              show: chatRowShow,
            };
        return {
          scope,
          current,
          state,
          list,
          dimmed: scope.computerId !== LOCAL_COMPUTER && isDimmed(computers.find((computer) => computer.id === scope.computerId)),
          pinned: rows.filter((row) => row.pinned),
          rest: rows.filter((row) => !row.pinned),
          done: all.filter((row) => row.doneAt),
        };
      })
    : [];
  // The Chats group's homes, each read like a Project's group; their rows merge into one list (chatsSidebarRows).
  const homeGroups = buildGroups
    ? homeScopes.map((key) => {
        const current = key === currentKey;
        const state = scopeStates[key] ?? cachedProjectCopy(key)?.state;
        const all = withBeats(
          key,
          current ? listedRecents : state ? unarchived(key, pendingDone(key, scopeChats(key, state, chatOrder, marks, { gitless: true }))) : [],
        );
        const rows = withoutDone(all);
        const list = {
          isActive: current ? (item: SidebarRecent) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle) : NEVER_ACTIVE,
          collapsed: false,
          // The open home's actions come gitless from the window (App's chatActions), the rest from here.
          actions: current ? chatActions : actionsFor(key, true),
          showHints: current && showHints,
          onPick: current ? pickChat : pickerFor(key),
          onHover: hoverFor(key),
          linkProjectId: null,
          computer: rowComputer(key),
          show: chatRowShow,
        };
        const offline = computerOfKey(key) !== LOCAL_COMPUTER && isDimmed(computers.find((computer) => computer.id === computerOfKey(key)));
        return {
          key,
          current,
          list,
          offline,
          pinned: rows.filter((row) => row.pinned),
          rest: rows.filter((row) => !row.pinned),
          done: all.filter((row) => row.doneAt),
        };
      })
    : [];
  const chatsRows: ChatsGroupRow[] = chatsSidebarRows(
    homeGroups.map(({ key, offline, pinned, rest }) => ({ key, offline, rows: [...pinned, ...rest] })),
    chatOrder,
  );
  const chatsScopes = new Map(
    homeGroups.map(({ key, list, pinned, rest }) => [
      key,
      { name: CHATS_GROUP_LABEL, badge: { projectImage: null, projectInitial: "" }, list, rows: [...pinned, ...rest] },
    ]),
  );
  // Grouped by Project: one repository's copies on several computers (one Git origin) share a heading, in its first
  // copy's place, and their chats merge under it, each naming its computer.
  const sections =
    showAll && !oneList ? groupByOrigin(groups.map((group) => ({ ...group, origin: group.scope.origin, computerId: group.scope.computerId }))) : [];
  // A Link's icon is its first Project's.
  const linkFirstProject = (scope: (typeof scopes)[number], link: NamedProjectLink, current: boolean) => {
    const firstId = link.projectIds[0];
    return (
      (firstId ? registeredProjects.find((project) => project.id === firstId) : undefined) ??
      (current ? selectedLink?.projects[0] : undefined) ?? { path: "", name: scope.name || "Project" }
    );
  };
  // Each scope's icon, on One list rows and grouped family rows.
  const scopeBadge = (scope: (typeof scopes)[number], current: boolean): ScopeBadge => {
    if (scope.link) {
      const first = linkFirstProject(scope, scope.link, current);
      return { projectImage: scopeImage(first.path) ?? null, projectInitial: first.name, linkProjects: scope.link.projectIds.length };
    }
    return {
      projectImage: (current && !selectedLink ? workspace.image : scopeImage(scope.key)) ?? null,
      projectInitial: scope.initial || scope.name,
    };
  };
  // Collapsed with two or more scopes: one icon per scope instead of the open one's chat initials.
  const scopeIcon = (scope: (typeof scopes)[number], current: boolean) => {
    if (scope.link) {
      const first = linkFirstProject(scope, scope.link, current);
      const fallback = (first.name.trim().slice(0, 1) || scope.name.trim().slice(0, 1) || "P").toUpperCase();
      return (
        <span
          data-rail-link-icon
          className="relative flex size-6 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface"
        >
          <span className="flex size-full items-center justify-center opacity-35">
            <WorkspaceIcon src={scopeImage(first.path)} fallback={fallback} />
          </span>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-surface drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]">
            <HugeIcon icon={Link04Icon} size={13} />
          </span>
        </span>
      );
    }
    return (
      <span className="flex size-6 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
        <WorkspaceIcon src={current && !selectedLink ? workspace.image : scopeImage(scope.key)} fallback={scope.initial} />
      </span>
    );
  };
  const railScopes: RailScope[] | null =
    collapsed && !oneList && scopes.length > 1
      ? scopes.map((scope) => {
          const current = scope.key === currentKey;
          const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
          const rows = current
            ? recents
            : state
              ? withoutDone(unarchived(scope.key, pendingDone(scope.key, scopeChats(scope.key, state, chatOrder, marks))))
              : [];
          const { status, chats } = railLive(rows);
          return { key: scope.key, name: scope.name, icon: scopeIcon(scope, current), current, status, chats };
        })
      : null;
  const openRailScope = (key: string) => {
    if (key.startsWith("milagre-link:")) onSwitchLink?.(key.slice("milagre-link:".length));
    else onSwitchProject?.(key);
  };
  const openRailChat = (key: string, id: string) => {
    if (key === currentKey) {
      const item = recents.find((row) => row.id === id);
      if (item) pickChat(item);
    } else onOpenScopeChat?.(key, id);
  };
  // Every list whose chats can take a canvas Link: the Link icons, "Link with…" and drops across Projects read these.
  const currentLinkId = selectedLink ? null : linkProjectIdOf(projectPath);
  const linkScopes: LinkScopeChats[] = showAll
    ? groups.flatMap(({ scope, list, pinned, rest }) =>
        list.linkProjectId ? [{ scopeKey: scope.key, projectId: list.linkProjectId, projectName: scope.name, rows: [...pinned, ...rest] }] : [],
      )
    : currentLinkId && projectPath
      ? [{ scopeKey: projectPath, projectId: currentLinkId, projectName: workspaceName, rows: recents }]
      : [];
  const anyPinned = groups.some((group) => group.pinned.length > 0) || homeGroups.some((group) => group.pinned.length > 0);
  // Every shown scope's Done chats in one section at the bottom, most recently marked first; the open scope's alone while
  // the sidebar shows just it.
  const doneEntries: DoneEntry[] = (
    showAll
      ? [...homeGroups.map(({ key, list, done }) => ({ key, list, done })), ...groups.map(({ scope, list, done }) => ({ key: scope.key, list, done }))]
      : [
          {
            key: currentKey,
            list: { onPick: pickChat, actions: chatActions, computer: rowComputer(currentKey) },
            done: listedRecents.filter((row) => row.doneAt),
          },
        ]
  )
    .flatMap(({ key, list, done }) =>
      done.map((item) => ({ key, item, onPick: list.onPick, onReopen: list.actions.onReopen && reopenFromDone(list.actions), computer: list.computer })),
    )
    .sort((a, b) => (b.item.doneAt ?? 0) - (a.item.doneAt ?? 0));
  // Each group's slot in the Pinned section, for its list's portal; one ref callback per key, so slots don't remount.
  const [pinSlots, setPinSlots] = useState<Record<string, HTMLElement | null>>({});
  const pinSlotRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const pinSlotRef = (key: string) => {
    let ref = pinSlotRefs.current.get(key);
    if (!ref) {
      ref = (node) => setPinSlots((slots) => (slots[key] === node ? slots : { ...slots, [key]: node }));
      pinSlotRefs.current.set(key, ref);
    }
    return ref;
  };
  const [closedScopes, setClosedScopes] = useState(readClosedScopes);
  const toggleScope = (key: string) =>
    setClosedScopes((previous) => {
      const next = previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key];
      localStorage.setItem(CLOSED_SCOPES_KEY, JSON.stringify(next));
      return next;
    });

  const [removingProject, setRemovingProject] = useState<{ path: string; name: string } | null>(null);

  // Checked in the project chooser; the choice belongs to this Mac alone.
  const showProject = (path: string, show: boolean) => {
    if (isRemoteKey(path)) {
      remote.setHidden(path, !show);
      return;
    }
    if (path.startsWith("milagre-link:")) {
      const id = path.slice("milagre-link:".length);
      const link = namedLinks.find((l) => l.id === id);
      if (link) {
        setNamedLinks((links) => links.map((l) => (l.id === id ? { ...l, hidden: !show } : l)));
        window.milagre?.updateNamedLink?.({ id, name: link.name, projectIds: link.projectIds, hidden: !show }).catch(() => {
          setListsChanged((count) => count + 1);
        });
      }
      return;
    }
    setRecentProjects((list) => list.map((project) => (project.path === path ? { ...project, hidden: !show } : project)));
    window.milagre?.setProjectHidden?.(path, !show).then(
      (list) => {
        if (Array.isArray(list)) setRecentProjects(list);
        window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
      },
      () => setListsChanged((count) => count + 1),
    );
  };
  // By name, like the phone's: the recent list reorders as Projects open, and a row must not move under the pointer.
  // Other computers' Projects follow, listed under their computer; the open one of another computer is already a local row.
  const pickerProjects: PickerProject[] = [
    ...projects.map((row) => {
      const recent = recentProjects.find((project) => project.path === row.path) ?? remote.projects.find((project) => project.path === row.path);
      return { ...row, shown: !recent?.hidden, listed: !!recent, computerId: computerOfKey(row.path) };
    }),
    ...namedLinks.map((link) => ({
      path: `milagre-link:${link.id}`,
      name: link.name,
      initial: link.name.slice(0, 1).toUpperCase(),
      current: link.id === selectedLink?.id,
      shown: !link.hidden,
      listed: true,
      computerId: LOCAL_COMPUTER,
    })),
    ...remote.projects
      .filter((project) => !projects.some((row) => row.path === project.path))
      .map((project) => ({
        path: project.path,
        name: project.name,
        initial: project.name.slice(0, 1).toUpperCase(),
        current: false,
        shown: !project.hidden,
        listed: true,
        computerId: project.computerId,
      })),
  ]
    // A hidden computer's Projects leave the chooser too; the open one stays, as it stays in the sidebar. No Chats home is a Project.
    .filter((project) => !isHome(project.path) && (project.current || !hiddenComputers.has(project.computerId)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));

  // A Project's ⋯ rows include removal, even for the open Project. A Link gets its name copied and can be edited.
  const scopeMenu = (scope: { key: string; name: string; link: NamedProjectLink | null }): ScopeMenuItem[] => {
    const link = scope.link;
    if (link)
      return [
        { key: "copy-name", label: "Copy Link name", icon: Copy01Icon, run: () => copy(scope.name) },
        ...(onEditLink ? [{ key: "edit", label: "Edit Link…", icon: PencilEdit02Icon, run: () => onEditLink(link.id) }] : []),
      ];
    const actions: Record<ProjectMenuKey, Pick<ScopeMenuItem, "run" | "disabled">> = {
      reveal: { run: () => void window.milagre?.revealInFolder(scope.key).catch(() => {}) },
      "copy-path": { run: () => copy(unqualifyKey(scope.key)) },
      "copy-name": { run: () => copy(scope.name) },
      settings: { run: () => onOpenProjectSettings?.(scope.key), disabled: !onOpenProjectSettings },
    };
    return [
      ...projectMenuActions(IS_MAC)
        .filter((item) => item.key !== "reveal" || !isRemoteKey(scope.key))
        .map((item) => ({ key: item.key, label: item.label, icon: PROJECT_MENU_ICONS[item.key], ...actions[item.key] })),
      {
        key: "remove",
        label: "Remove Project",
        icon: Cancel01Icon,
        destructive: true,
        separatorBefore: true,
        run: () => setRemovingProject({ path: scope.key, name: scope.name }),
      },
    ];
  };

  const collapse = () => {
    setCollapsed(true);
  };

  // A manual toggle is the user's choice: the window width stops overriding it until the next crossing.
  const toggle = () => {
    autoCollapsed.current = false;
    if (collapsed) setCollapsed(false);
    else collapse();
  };

  useEffect(() => {
    const query = window.matchMedia(AUTO_COLLAPSE_QUERY);
    const follow = () => {
      if (query.matches) {
        setCollapsed((current) => {
          if (!current) autoCollapsed.current = true;
          return true;
        });
      } else if (autoCollapsed.current) {
        autoCollapsed.current = false;
        setCollapsed(false);
      }
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  // Its key (⌘B by default) toggles the sidebar exactly like its collapse button.
  useEffect(() => {
    function handleToggle(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (shortcutCommand(event) !== "sidebar.toggle") return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", handleToggle);
    return () => window.removeEventListener("keydown", handleToggle);
  }, [collapsed]);

  const saveWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setExpandedWidth(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  };

  // One list: the unpinned rows of every scope in one column. The pinned ones stay in their scope's slot of the Pinned
  // section, where they still drag; each scope's list renders just those.
  const flatScopes = new Map(
    groups.map(({ scope, current, list, pinned, rest }) => [
      scope.key,
      { name: scope.name, badge: scopeBadge(scope, current), list, rows: [...pinned, ...rest] },
    ]),
  );
  const flatChats = oneList
    ? mergeScopeChats(
        groups.map(({ scope, rest }) => ({ key: scope.key, rows: rest })),
        chatOrder,
      )
    : [];
  // Match the expanded list: pinned homes and Projects first, then the Chats group and the merged Project rows.
  const railItems: RailScope[] | null =
    collapsed && oneList
      ? [
          ...homeGroups.flatMap(({ key, pinned }) => pinned.map((row) => ({ scopeKey: key, row }))),
          ...groups.flatMap(({ scope, pinned }) => pinned.map((row) => ({ scopeKey: scope.key, row }))),
          ...chatsRows,
          ...flatChats,
        ].map(({ scopeKey, row }) => {
          const scope = scopes.find((item) => item.key === scopeKey);
          const current = scopeKey === currentKey;
          return {
            key: `${scopeKey}#${row.id}`,
            name: scope?.name ?? CHATS_GROUP_LABEL,
            icon: scope ? scopeIcon(scope, current) : <HugeIcon icon={BubbleChatIcon} size={20} />,
            current: current && (activeId !== undefined ? row.id === activeId : row.label === selectedTitle),
            status: railLive([row]).status,
            chats: [row],
            chat: { scopeKey, id: row.id },
          };
        })
      : railScopes;
  const loadingScopes = groups.some(({ scope, state, current }) => !state && !current && !failedScopes.has(scope.key));
  // Pinned Chats without a Project sit in the Pinned section like any other, in both layouts.
  const chatsPinned = homeGroups.map(({ key, list, pinned }) =>
    pinned.length > 0 ? (
      <ChatList key={key} recents={pinned} scopeKey={key} {...list} header={null} pinnedTarget={pinSlots[key] ?? null} anyPinned={anyPinned} />
    ) : null,
  );
  const chatsOpen = !closedScopes.includes(CHATS_GROUP_KEY);
  // Folds like a Project's group. It shows only while some computer has a Chat without a Project outside Pinned; with
  // none, a new Chat's No project row starts one.
  const chatsGroup = chatsRows.length > 0 && (
    <section data-sidebar-chats aria-label={CHATS_GROUP_LABEL} className="mb-2">
      <ScopeHeader
        name={CHATS_GROUP_LABEL}
        icon={
          <span className="flex size-5 items-center justify-center rounded-[6px] bg-ink text-surface">
            <HugeIcon icon={BubbleChatIcon} size={12} />
          </span>
        }
        open={chatsOpen}
        current={homeGroups.some(({ current }) => current)}
        // ⌘N from a Chat without a Project starts in a real Project, so this + is never the open scope's own.
        plusIsCurrent={false}
        attention={homeGroups.some(({ key, current }) => !current && attentionPaths.includes(key))}
        onToggle={() => toggleScope(CHATS_GROUP_KEY)}
        onNewChat={
          onNewChatWithoutProject &&
          (() => {
            if (activeTitle === undefined) setDemoActiveTitle(null);
            onNewChatWithoutProject();
          })
        }
        menu={[]}
      />
      <div
        inert={!chatsOpen}
        data-scope-body
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{ gridTemplateRows: chatsOpen ? "1fr" : "0fr", opacity: chatsOpen ? 1 : 0 }}
      >
        <div className="min-w-0 overflow-hidden">
          <FlatChatList chats={chatsRows} scopes={chatsScopes} inbox={false} />
        </div>
      </div>
    </section>
  );
  const flatBody = (
    <>
      {groups.map(({ scope, current, pinned, list }) =>
        pinned.length > 0 ? (
          <ChatList
            {...scopeBadge(scope, current)}
            key={scope.key}
            recents={pinned}
            scopeKey={scope.key}
            {...list}
            header={null}
            pinnedTarget={pinSlots[scope.key] ?? null}
            anyPinned={anyPinned}
            projectName={scope.name}
          />
        ) : null,
      )}
      <div data-one-list-header className="sidebar-copy mx-2 mb-1 flex h-8 items-center justify-between pl-2">
        <span className="text-[length:calc(12.5px+var(--sidebar-delta))] font-medium text-ink-3">{ALL_CHATS_LABEL}</span>
        <Tooltip label="New chat" shortcut={keys.newChat} align="end">
          <button
            type="button"
            aria-label="New chat"
            onClick={() => {
              if (activeTitle === undefined) setDemoActiveTitle(null);
              onNewChat?.();
            }}
            className={CHATS_HEADER_BUTTON}
          >
            <IconPlusMedium size={16} />
          </button>
        </Tooltip>
      </div>
      {chatsGroup}
      {/* It parts the Chats from the Projects' rows below, so it shows only when there are both. */}
      {chatsGroup && flatChats.length > 0 && <div aria-hidden data-chats-divider className="mx-4 mb-2 border-t border-line" />}
      <FlatChatList chats={flatChats} scopes={flatScopes} />
      {groups
        .filter(({ scope, state, current }) => !state && !current && failedScopes.has(scope.key))
        .map(({ scope }) => (
          <p key={scope.key} className="mx-2 flex h-8 items-center gap-1 pl-2 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
            <span className="truncate">Couldn't load chats of {scope.name}.</span>
            <button type="button" onClick={() => retryScope(scope.key)} className="shrink-0 cursor-pointer text-ink-2 underline-offset-2 hover:underline">
              Retry
            </button>
          </p>
        ))}
      {groups.length > 0 && flatChats.length === 0 && chatsRows.length === 0 && !anyPinned && (
        <p data-one-list-empty className="mx-2 h-8 pl-2 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">
          {loadingScopes ? "Loading chats…" : "No chats yet"}
        </p>
      )}
    </>
  );

  // One repository on several computers: one heading, the copies' chats in one list by time, each row naming its
  // computer. Pinned rows still go to their own copy's slot in Pinned. The heading folds, adds and opens its menu for
  // the first copy (This Mac's when it has one); + starts the Chat where the open copy is, else where the last one went.
  const mergedSection = (section: (typeof sections)[number]) => {
    const { scope, copies } = section;
    const open = !closedScopes.includes(scope.key);
    const current = copies.find((part) => part.current);
    const iconScope = current?.scope ?? scope;
    const chats = mergeScopeChats(
      copies.map((part) => ({ key: part.scope.key, rows: part.rest })),
      chatOrder,
    );
    const lists = new Map(
      copies.map((part) => [part.scope.key, { name: part.scope.name, badge: NO_BADGE, list: part.list, rows: [...part.pinned, ...part.rest] }]),
    );
    const failed = copies.filter((part) => !part.state && !part.current && failedScopes.has(part.scope.key));
    const loading = copies.some((part) => !part.state && !part.current && !failedScopes.has(part.scope.key));
    const dimmed = copies.every((part) => part.dimmed);
    return (
      <section
        key={scope.key}
        data-sidebar-scope={scope.key}
        data-sidebar-copies={copies.map((part) => part.scope.key).join("\n")}
        data-current={current ? true : undefined}
        aria-label={scope.name}
        data-offline={dimmed || undefined}
        className={`mb-2 ${dimmed ? "opacity-50" : ""}`}
      >
        <ScopeHeader
          name={scope.name}
          icon={
            <span className="flex size-5 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
              <WorkspaceIcon src={current && !selectedLink ? workspace.image : scopeImage(iconScope.key)} fallback={iconScope.initial} />
            </span>
          }
          open={open}
          current={!!current}
          attention={copies.some((part) => !part.current && attentionPaths.includes(part.scope.key))}
          onToggle={() => toggleScope(scope.key)}
          onNewChat={() => {
            if (current) {
              if (activeTitle === undefined) setDemoActiveTitle(null);
              (onNewCurrentScopeChat ?? onNewChat)?.();
              return;
            }
            const [first, ...others] = copies.map((item): ScopeCopy => ({ key: item.scope.key, computerId: item.scope.computerId }));
            const picked = preferredCopy(scope.origin, [first!, ...others]);
            rememberProjectComputer({ origin: scope.origin, computerId: picked.computerId });
            onNewChatInScope?.(picked.key);
          }}
          menu={scopeMenu(scope)}
        />
        {copies.map((part) =>
          part.pinned.length > 0 ? (
            <ChatList
              key={part.scope.key}
              {...scopeBadge(part.scope, part.current)}
              recents={part.pinned}
              scopeKey={part.scope.key}
              {...part.list}
              header={null}
              pinnedTarget={pinSlots[part.scope.key] ?? null}
              anyPinned={anyPinned}
            />
          ) : null,
        )}
        <div
          inert={!open}
          data-scope-body
          className="grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        >
          <div className="min-w-0 overflow-hidden">
            <FlatChatList chats={chats} scopes={lists} inbox={false} />
            {failed.map((part) => (
              <p key={part.scope.key} className="mx-2 flex h-8 items-center gap-1 pl-9 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
                <span className="truncate">Couldn't load chats{part.list.computer ? ` on ${part.list.computer.name}` : ""}.</span>
                <button
                  type="button"
                  onClick={() => retryScope(part.scope.key)}
                  className="shrink-0 cursor-pointer text-ink-2 underline-offset-2 hover:underline"
                >
                  Retry
                </button>
              </p>
            ))}
            {chats.length === 0 && failed.length === 0 && !copies.some((part) => part.pinned.length > 0) && (
              <p className="mx-2 h-8 pl-9 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">{loading ? "Loading chats…" : "No chats yet"}</p>
            )}
          </div>
        </div>
      </section>
    );
  };

  const chrome = useWindowChrome();
  // The bar's controls end where they end; a diff's Back and a bot's header start after them.
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node) return;
    const report = () => setBarControlsWidth(node.offsetWidth);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      observer.disconnect();
      setBarControlsWidth(0);
    };
  }, []);
  return (
    <div className={`relative flex min-h-0 shrink-0 flex-col ${fill ? "h-full" : "h-[600px]"} ${className}`}>
      {/* The window's top bar, beside its controls: the sidebar toggle, then Canvas, Routines, Link projects and Search.
          A scrolled chat runs under it, so the group sits on a solid pill. */}
      <div
        ref={bar}
        data-sidebar-bar
        className="absolute top-[calc(var(--window-chrome-top)-var(--window-chrome-height))] z-[60] flex items-center gap-1 rounded-[10px] bg-page"
        style={{ left: chrome.sidebarLeft - 12 }}
      >
        <div data-sidebar-toggle>
          <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut={keys.sidebar} side="bottom">
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              onClick={toggle}
              className="flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink [-webkit-app-region:no-drag]"
            >
              <span className="pointer-events-none flex items-center justify-center">
                <HugeIcon icon={collapsed ? SidebarRight01Icon : SidebarLeft01Icon} size={18} />
              </span>
            </button>
          </Tooltip>
        </div>
        {!botsMode && (
          <div data-sidebar-tools className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            {onOpenCanvas && (
              <Tooltip label="Canvas" side="bottom">
                <button
                  type="button"
                  aria-label="Canvas"
                  aria-pressed={canvasActive}
                  onClick={onOpenCanvas}
                  className={`${TOOL_BUTTON} size-8 ${canvasActive ? "bg-hover-2 text-ink" : ""}`}
                >
                  <HugeIcon icon={FrameIcon} size={16} />
                </button>
              </Tooltip>
            )}
            {onOpenRoutines && (
              <Tooltip label="Routines" side="bottom">
                <button
                  type="button"
                  // The dot is drawn only; the label says it, as the phone's dock button does.
                  aria-label={routinesUnread ? "Routines, unread Runs" : "Routines"}
                  aria-pressed={routinesActive}
                  data-sidebar-routines
                  onClick={onOpenRoutines}
                  className={`${TOOL_BUTTON} relative size-8 ${routinesActive ? "bg-hover-2 text-ink" : ""}`}
                >
                  {/* The dot sits on the icon's top-right corner, cut out of it by its ring. */}
                  <span className="relative flex">
                    <HugeIcon icon={RepeatIcon} size={16} />
                    {routinesUnread && (
                      <span aria-hidden data-routines-unread className="absolute -top-1 -right-1 size-2 rounded-full bg-accent ring-2 ring-canvas" />
                    )}
                  </span>
                </button>
              </Tooltip>
            )}
            {onLinkProject && (
              <Tooltip label="Link projects" side="bottom">
                <button type="button" aria-label="Link projects" data-link-projects onClick={onLinkProject} className={`${TOOL_BUTTON} size-8`}>
                  <HugeIcon icon={Link04Icon} size={16} />
                </button>
              </Tooltip>
            )}
            {onOpenCommands && (
              <Tooltip label="Search commands, chats, and projects" side="bottom" shortcut={keys.search}>
                <button
                  type="button"
                  aria-label="Command palette"
                  aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
                  onClick={onOpenCommands}
                  className={`${TOOL_BUTTON} size-8`}
                >
                  <IconMagnifyingGlass size={16} />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      <aside
        data-sidebar-collapsed={collapsed}
        aria-label="Workspace navigation"
        className="relative flex min-h-0 shrink-0 overflow-hidden rounded-window bg-surface shadow-card transition-[width]"
        style={
          {
            width: collapsed ? SIDEBAR_MOTION.collapsedWidth : expandedWidth,
            flex: "1 1 0%",
            // Following the pointer while dragging; the eased width transition would make the edge lag behind it.
            transitionDuration: resizing ? "0ms" : `calc(${SIDEBAR_MOTION.duration}ms * var(--motion-scale))`,
            transitionTimingFunction: SIDEBAR_MOTION.easing,
            "--sidebar-copy-duration": `calc(${SIDEBAR_MOTION.copyDuration}ms * var(--motion-scale))`,
            "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
            "--sidebar-easing": SIDEBAR_MOTION.easing,
          } as CSSProperties
        }
      >
        <div className="flex min-h-0 w-full shrink-0 flex-col">
          {botsOn && (
            <div className="shrink-0 pt-2">
              <SidebarModeSwitch mode={botsMode ? "bots" : "projects"} onMode={(mode) => onSidebarMode?.(mode)} collapsed={collapsed} />
            </div>
          )}
          <ScrollArea
            ref={scrollRef}
            onScroll={(event) => {
              if (event.currentTarget.isConnected && restoreScroll.current === null) scrollPositions.set(scrollKey, event.currentTarget.scrollTop);
            }}
            className={`sidebar-scroll flex-1 overflow-x-hidden ${botsOn ? "" : "pt-2"}`}
          >
            {botsMode ? (
              <BotList snapshot={bots.snapshot} selectedBotId={selectedBotId} onPickBot={(id) => onPickBot?.(id)} collapsed={collapsed} />
            ) : (
              <BotMarksContext.Provider value={botMarks}>
                <SidebarLinksProvider scopes={linkScopes} projects={registeredProjects} onAskChat={onAskChat}>
                  {showAll ? (
                    <>
                      {/* Pinned chats of every Project and Link sit on top, like the single-project sidebar. Each group's list
                    renders its pinned rows into its slot here, so a drag moves a chat between Pinned and its group. */}
                      <div data-all-pinned={anyPinned || undefined} className={anyPinned ? "mb-2" : ""}>
                        {anyPinned && (
                          <p className="sidebar-copy mx-2 mb-1 h-8 pl-2 text-[length:calc(12.5px+var(--sidebar-delta))] font-medium leading-8 text-ink-3">
                            Pinned
                          </p>
                        )}
                        {homeGroups.map(({ key }) => (
                          <div key={key} ref={pinSlotRef(key)} data-pinned-scope={key} />
                        ))}
                        {groups.map((group) => (
                          <div key={group.scope.key} ref={pinSlotRef(group.scope.key)} data-pinned-scope={group.scope.key} />
                        ))}
                      </div>
                      {chatsPinned}
                      {!oneList && chatsGroup}
                      {oneList
                        ? flatBody
                        : sections.map((section, index) => {
                            if (section.copies.length > 1) return mergedSection(section);
                            const { scope, current, state, rest, pinned, list, dimmed } = section;
                            const open = !closedScopes.includes(scope.key);
                            return (
                              <section
                                key={scope.key}
                                data-sidebar-scope={scope.key}
                                data-current={current || undefined}
                                aria-label={scope.name}
                                data-offline={dimmed || undefined}
                                className={`mb-2 ${dimmed ? "opacity-50" : ""}`}
                              >
                                {scope.link && !sections[index - 1]?.scope.link && (
                                  <p className="mx-2 mt-1 mb-1 h-6 pl-2 text-[length:calc(12.5px+var(--sidebar-delta))] font-medium leading-6 text-ink-3">
                                    Links
                                  </p>
                                )}
                                <ScopeHeader
                                  name={scope.name}
                                  icon={
                                    scope.link ? (
                                      <ProjectAvatarStack
                                        projects={scope.link.projectIds.map(
                                          (id) => registeredProjects.find((project) => project.id === id) ?? { path: "", name: "Project" },
                                        )}
                                      />
                                    ) : (
                                      <span className="flex size-5 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
                                        <WorkspaceIcon src={current && !selectedLink ? workspace.image : scopeImage(scope.key)} fallback={scope.initial} />
                                      </span>
                                    )
                                  }
                                  open={open}
                                  current={current}
                                  attention={!current && attentionPaths.includes(scope.key)}
                                  computer={list.show.computer ? list.computer : undefined}
                                  onToggle={() => toggleScope(scope.key)}
                                  onNewChat={
                                    current
                                      ? () => {
                                          if (activeTitle === undefined) setDemoActiveTitle(null);
                                          (onNewCurrentScopeChat ?? onNewChat)?.();
                                        }
                                      : () => onNewChatInScope?.(scope.key)
                                  }
                                  menu={scopeMenu(scope)}
                                />
                                {/* Rows grow open and shut instead of appearing at once; closed ones leave the tab order. */}
                                <div
                                  inert={!open}
                                  data-scope-body
                                  className="grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
                                  style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
                                >
                                  <div className="min-w-0 overflow-hidden">
                                    {rest.length > 0 || pinned.length > 0 ? (
                                      <ChatList
                                        {...scopeBadge(scope, current)}
                                        recents={pinned.length ? [...pinned, ...rest] : rest}
                                        scopeKey={scope.key}
                                        {...list}
                                        header={null}
                                        pinnedTarget={pinSlots[scope.key] ?? null}
                                        anyPinned={anyPinned}
                                      />
                                    ) : !state && !current && failedScopes.has(scope.key) ? (
                                      <p className="mx-2 flex h-8 items-center gap-1 pl-9 text-[length:calc(13px+var(--sidebar-delta))] text-ink-3">
                                        Couldn't load chats.
                                        <button
                                          type="button"
                                          onClick={() => retryScope(scope.key)}
                                          className="cursor-pointer text-ink-2 underline-offset-2 hover:underline"
                                        >
                                          Retry
                                        </button>
                                      </p>
                                    ) : (
                                      <p className="mx-2 h-8 pl-9 text-[length:calc(13px+var(--sidebar-delta))] leading-8 text-ink-3">
                                        {state || current ? "No chats yet" : "Loading chats…"}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </section>
                            );
                          })}
                    </>
                  ) : railItems ? (
                    <ScopeRail scopes={railItems} onOpenScope={openRailScope} onOpenChat={openRailChat} />
                  ) : (
                    <ChatList
                      recents={recents}
                      projectImage={workspace.image}
                      projectInitial={workspace.name}
                      scopeKey={currentKey}
                      isActive={(item) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle)}
                      collapsed={collapsed}
                      actions={chatActions}
                      showHints={showHints}
                      onPick={pickChat}
                      onHover={hoverFor(currentKey)}
                      show={chatRowShow}
                      linkProjectId={selectedLink ? null : linkProjectIdOf(projectPath)}
                      header={
                        <div className={`sidebar-copy mx-2 mb-1 flex h-8 items-center justify-between pl-2 ${collapsed ? "hidden" : ""}`}>
                          <span className="text-[length:calc(12.5px+var(--sidebar-delta))] font-medium text-ink-3">Chats</span>
                          <Tooltip label="New chat" shortcut={keys.newChat} align="end">
                            <button
                              type="button"
                              aria-label="New chat"
                              onClick={() => {
                                if (activeTitle === undefined) setDemoActiveTitle(null);
                                onNewChat?.();
                              }}
                              className={CHATS_HEADER_BUTTON}
                            >
                              <IconPlusMedium size={16} />
                            </button>
                          </Tooltip>
                        </div>
                      }
                    />
                  )}
                </SidebarLinksProvider>
              </BotMarksContext.Provider>
            )}
          </ScrollArea>

          {botsMode && (
            <div className="mt-2 shrink-0">
              <NewBotButton collapsed={collapsed} onClick={() => setNewBotOpen(true)} />
            </div>
          )}
          {newBotOpen && (
            <NewBotSheet
              models={models}
              defaultModel={defaultModel}
              onClose={() => setNewBotOpen(false)}
              onCreated={(bot) => {
                setNewBotOpen(false);
                onPickBot?.(bot.id);
              }}
            />
          )}

          {!botsMode && <DoneSection entries={doneEntries} retentionHours={doneSettings.retentionHours} collapsed={collapsed} />}

          <SidebarToast collapsed={collapsed} />

          {usage && <div className={`mt-3 border-t border-line pt-1.5 ${collapsed ? "mx-auto w-8" : "mx-2 w-[calc(100%-16px)]"}`}>{usage}</div>}

          <div
            className={`flex border-t border-line py-1.5 ${usage ? "mt-1.5" : "mt-3"} ${collapsed ? "mx-auto w-8 flex-col-reverse items-center gap-1" : "mx-2 w-[calc(100%-16px)] items-center justify-between"}`}
          >
            <div className={collapsed ? "flex flex-col-reverse items-center gap-1" : "flex items-center gap-1"}>
              <Tooltip label="Add project" shortcut={keys.addProject}>
                <button
                  type="button"
                  aria-label="Add project"
                  onClick={() => onOpenProject?.()}
                  className={`${BOTTOM_BAR_BUTTON} ${collapsed ? "size-8" : "size-9"}`}
                >
                  <IconFolderAdd size={17} />
                </button>
              </Tooltip>
              <FiltersButton
                projects={pickerProjects}
                computers={multi ? computerSections(thisMac, computers) : null}
                imageOf={scopeImage}
                currentImage={selectedLink ? undefined : workspace.image}
                onShowProject={showProject}
                show={chatRowShow}
                offerComputer={multi}
                onShowField={(field, on) => updateSettings({ chatRowShow: { ...chatRowShow, [field]: on } })}
                collapsed={collapsed}
                className={`${BOTTOM_BAR_BUTTON} ${collapsed ? "size-8" : "size-9"}`}
              />
              {onAddComputer && onOpenComputerSettings && (
                <ComputersButton
                  collapsed={collapsed}
                  buttonClassName={BOTTOM_BAR_BUTTON}
                  onAddComputer={onAddComputer}
                  onOpenSettings={onOpenComputerSettings}
                />
              )}
            </div>
            <Tooltip label="Settings" shortcut={keys.settings} align={collapsed ? "start" : "end"}>
              <button
                type="button"
                data-update-settings=""
                aria-label="Settings"
                onClick={onOpenSettings}
                className={`relative ${BOTTOM_BAR_BUTTON} ${collapsed ? "size-8" : "size-9"}`}
              >
                <IconSettingsGear1 size={17} />
                <UpdateSettingsBadge />
              </button>
            </Tooltip>
          </div>
        </div>
      </aside>
      {removingProject && <RemoveProjectDialog project={removingProject} onClose={() => setRemovingProject(null)} />}
      {!collapsed && (
        <ResizeHandle
          label="Resize sidebar"
          side="right"
          width={expandedWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          reset={SIDEBAR_MIN_WIDTH}
          onResize={setExpandedWidth}
          onCommit={saveWidth}
          onResizingChange={setResizing}
        />
      )}
    </div>
  );
});

/* ─────────────────────────────────────────────────────────
 * CHAT LIST
 * Pinned chats on top in the user's order, the rest below in
 * the list's own order. A row dragged between two rows pins,
 * reorders or unpins it; dropped on the middle third of another
 * row, it offers a Link between the two chats' Worktrees, in
 * this Project's list or another's. The keyboard does the same
 * within the list: Space picks the focused row up, the arrows
 * move it, Space drops it and Escape cancels.
 * ───────────────────────────────────────────────────────── */

/** A press that moves this far is a drag; less is still a click that opens the chat. */
const DRAG_THRESHOLD = 4;
const DROP_HINTS = { "same-worktree": "Same worktree: a Link joins two different Worktrees", linked: "Already linked" };

/**
 * Where a dragged chat would land: next to or on a row, or (id null) in the empty Pinned section. `scope` is another
 * Project's list, where a drop can only link.
 */
type DropTarget = { id: string | null; zone: DropZone; scope?: string };
type ChatDrag = { id: string; target: DropTarget | null; keyboard: boolean };

const sameTarget = (a: DropTarget | null, b: DropTarget | null) => a?.id === b?.id && a?.zone === b?.zone && a?.scope === b?.scope;

/** What a list's rows read when an action runs: the latest rows, actions and Links. */
type RowActionsNow = { recents: SidebarRecent[]; actions: ChatRowActions; sidebarLinks: ReturnType<typeof useSidebarLinks> };

/** Done as a step in the undo history: ⌘Z reopens the Chat, ⇧⌘Z moves it to Done again. */
const doneStep = (actions: () => ChatRowActions, id: string): UndoAction => ({
  text: "Moved to Done",
  kind: "done",
  undoneText: "Back in Chats",
  undo: () => actions().onReopen?.(id),
  redo: () => actions().onDone?.(id),
});
/** Reopen (from the Done section or the row menu), the same step the other way round. */
const reopenStep = (actions: () => ChatRowActions, id: string): UndoAction => ({
  text: "Back in Chats",
  kind: "undone",
  undoneText: "Moved to Done",
  undoneKind: "done",
  undo: () => actions().onDone?.(id),
  redo: () => actions().onReopen?.(id),
});

/** The Done section's Reopen for a list, recorded like the row menu's; one function per set of actions, so rows keep their memo. */
const reopeners = new WeakMap<ChatRowActions, (id: string) => void>();
function reopenFromDone(actions: ChatRowActions) {
  let reopen = reopeners.get(actions);
  if (!reopen) {
    reopen = (id) => {
      actions.onReopen?.(id);
      undoHistory.record(reopenStep(() => actions, id));
    };
    reopeners.set(actions, reopen);
  }
  return reopen;
}

/**
 * A scope's row actions: pinning, Done, Reopen and deletion that can be undone from a toast or with ⌘Z, and the Link items that open the shared "Link with…"
 * and "Remove Link with…" lists. `now` reads the latest state, so one object serves every render.
 */
function chatRowActions(actions: ChatRowActions, linkProjectId: string | null, scopeKey: string, now: () => RowActionsNow): ChatRowActions {
  return {
    ...actions,
    onPin:
      actions.onPin &&
      ((id, order) => {
        const latest = now();
        const item = latest.recents.find((row) => row.id === id);
        if (!item || !latest.actions.onPin) return;
        const orders = latest.recents.filter((row) => row.pinned && row.id !== id).map((row) => row.pinOrder ?? 0);
        const next = order === undefined ? pinOrderAt(orders, orders.length) : order;
        const previous = item.pinned ? (item.pinOrder ?? 0) : null;
        latest.actions.onPin(id, next);
        if ((previous === null) !== (next === null))
          undoHistory.record({
            text: next === null ? "Unpinned" : "Pinned",
            undoneText: next === null ? "Pinned" : "Unpinned",
            undo: () => now().actions.onPin?.(id, previous),
            redo: () => now().actions.onPin?.(id, next),
          });
      }),
    onDone:
      actions.onDone &&
      ((id) => {
        const latest = now().actions;
        if (!latest.onDone) return;
        latest.onDone(id);
        undoHistory.record(doneStep(() => now().actions, id));
      }),
    onReopen:
      actions.onReopen &&
      ((id) => {
        const latest = now().actions;
        if (!latest.onReopen) return;
        latest.onReopen(id);
        undoHistory.record(reopenStep(() => now().actions, id));
      }),
    onArchive:
      actions.onArchive &&
      ((id, mode, plan) => {
        const latest = now().actions;
        const work = latest.onArchive?.(id, mode, plan);
        if (!latest.onUndoArchive) undoHistory.notify("Chat deleted");
        else
          undoHistory.record({
            text: "Chat deleted",
            kind: "deleted",
            undoneText: "Chat restored",
            // Only while the deletion waits out its Undo window. No redo: ⇧⌘Z never deletes a Worktree.
            undo: () => now().actions.onUndoArchive?.(id) ?? false,
            undoWindowMs: DELETE_UNDO_MS,
          });
        return work;
      }),
    ...(linkProjectId
      ? {
          onLinkWith: (id: string, anchor: { top: number; left: number }) => {
            const item = now().recents.find((row) => row.id === id);
            if (item) now().sidebarLinks.pick({ scopeKey, item }, anchor, "link");
          },
          onRemoveLink: (id: string, anchor: { top: number; left: number }) => {
            const item = now().recents.find((row) => row.id === id);
            if (item) now().sidebarLinks.pick({ scopeKey, item }, anchor, "remove");
          },
        }
      : {}),
  };
}

/** An inbox row's Project icon, as ChatRow's props: plain values, so memo'd rows keep them. */
type ScopeBadge = { projectImage: string | null; projectInitial: string; linkProjects?: number };

/** What the one-list sidebar knows of a scope: the props its ChatList would get, and all its rows. */
type FlatScope = {
  name: string;
  /** The rows' Project icon. */
  badge: ScopeBadge;
  list: {
    isActive: (item: SidebarRecent) => boolean;
    actions: ChatRowActions;
    showHints: boolean;
    onPick: (item: SidebarRecent) => void;
    onHover: (item: SidebarRecent) => void;
    linkProjectId: string | null;
    computer?: RowComputer;
    show: ChatRowShow;
  };
  /** Pinned rows first, then the rest, as the scope's own list orders them (the ⌘1–9 hints count along it). */
  rows: SidebarRecent[];
};

/**
 * Drags a one-list row onto the Chat view, the only place it drops: beside a grid tile or the Chat on screen
 * (lib/grid-drop.ts). A press that doesn't move past the threshold stays a click; Escape calls the drag off.
 */
function dragRowToGrid(event: ReactPointerEvent<HTMLElement>, key: string, onDragging: (key: string | null) => void) {
  const start = { x: event.clientX, y: event.clientY };
  let started = false;
  let target: GridDropTarget | null = null;
  const move = (moveEvent: PointerEvent) => {
    if (!started) {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
      started = true;
      onDragging(key);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    target = gridDrop.hit(moveEvent.clientX, moveEvent.clientY, key);
    gridDrop.show(target);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("keydown", escape, true);
    gridDrop.show(null);
    onDragging(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  const end = () => {
    stop();
    if (!started) return;
    // The press still ends in a click; it was a drag, so that click doesn't open the chat.
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (target) gridDrop.drop(key, target);
  };
  const escape = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape" || !started) return;
    keyEvent.preventDefault();
    stop();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("keydown", escape, true);
}

/**
 * The one-list sidebar's unpinned rows: chats of every scope in one column, each with its own scope's actions, marks,
 * Links and Project on the second line. Pinning goes through the row menu (pinned rows still drag in the Pinned
 * section); a row dragged out onto the Chat view joins the grid there.
 */
/** One copy of a repository merged under a shared heading: its key and computer, for picking where + starts a Chat. */
type ScopeCopy = { key: string; computerId: string };
const NO_BADGE: ScopeBadge = { projectImage: null, projectInitial: "" };

/**
 * Chats of several scopes in one column. `inbox` (the One list): each row leads with its Project's icon and name. Off,
 * under one repository's heading, the rows look like a Project's and name their computer instead.
 */
function FlatChatList({ chats, scopes, inbox = true }: { chats: (FlatChat & { offline?: boolean })[]; scopes: Map<string, FlatScope>; inbox?: boolean }) {
  const keys = useSidebarKeys();
  const listRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pressed = event.target as HTMLElement;
    const row = pressed.closest<HTMLElement>("[data-chat-key]");
    const key = row?.dataset.chatKey;
    if (!key || isLinkScopeKey(key.slice(0, key.lastIndexOf("#"))) || pressed.closest("a, input, [aria-haspopup]")) return;
    dragRowToGrid(event, key, setDragging);
  };
  const sidebarLinks = useSidebarLinks();
  const botMarks = useBotMarks();
  // Reads the latest render's scopes and Links when an action runs, so one set of actions serves every render.
  const readScope = useEvent((scopeKey: string): RowActionsNow => {
    const scope = scopes.get(scopeKey);
    return { recents: scope?.rows ?? [], actions: scope?.list.actions ?? {}, sidebarLinks };
  });
  const nowOf = (scopeKey: string) => () => readScope(scopeKey);
  // One object per scope and set of actions, so its rows keep their memo.
  const [made] = useState(() => new Map<string, { source: ChatRowActions; linkProjectId: string | null; actions: ChatRowActions }>());
  const actionsOf = (scopeKey: string, scope: FlatScope) => {
    const hit = made.get(scopeKey);
    if (hit && hit.source === scope.list.actions && hit.linkProjectId === scope.list.linkProjectId) return hit.actions;
    const actions = chatRowActions(scope.list.actions, scope.list.linkProjectId, scopeKey, nowOf(scopeKey));
    made.set(scopeKey, { source: scope.list.actions, linkProjectId: scope.list.linkProjectId, actions });
    return actions;
  };
  const folds = useSubchatFolds();
  // Where each scope's first nine rows sit in its list, the only ones with a ⌘1–9 hint: one pass per scope, not a scan per row.
  const hintPositions = useMemo(() => {
    const positions = new Map<SidebarRecent, number>();
    for (const [key, { list, rows }] of scopes)
      if (list.showHints)
        jumpChatRows(rows, key, folds)
          .slice(0, 9)
          .forEach((row, at) => positions.set(row, at));
    return positions;
  }, [scopes, folds]);
  // Subchats sit under their parent's row here too; pinned rows keep their place. A subchat's row opens it beside its parent.
  const openSubchat = useContext(OpenSubchatContext);
  const [subchatPicks] = useState(() => new Map<string, { onPick: (item: SidebarRecent) => void; pick: (item: SidebarRecent) => void }>());
  const pickSubchatIn = (scopeKey: string, onPick: (item: SidebarRecent) => void) => {
    const held = subchatPicks.get(scopeKey);
    if (held?.onPick === onPick) return held.pick;
    const pick = (item: SidebarRecent) => {
      if (!openSubchat?.(`${scopeKey}#${item.id}`)) onPick(item);
    };
    subchatPicks.set(scopeKey, { onPick, pick });
    return pick;
  };
  const shownFlat = useMemo(() => {
    const free = chats.filter((chat) => !chat.row.pinned);
    const nested = shownChats(free, {
      key: (chat) => `${chat.scopeKey}#${chat.row.id}`,
      parent: (chat) => (chat.row.parent === undefined ? undefined : `${chat.scopeKey}#${chat.row.parent}`),
      folded: folds,
      asking: (chat) => subchatAsks(chat.row),
    });
    if (free.length === chats.length) return nested;
    const pinned: (ShownRow & { item: (typeof chats)[number] })[] = chats.filter((chat) => chat.row.pinned).map((item) => ({ item, subchat: false }));
    return [...pinned, ...nested];
  }, [chats, folds]);
  return (
    <div ref={listRef} data-chat-list-flat className="flex flex-col gap-px" onPointerDown={startDrag}>
      {shownFlat.map(({ item: { scopeKey, row, offline }, subchat, family }) => {
        const scope = scopes.get(scopeKey)!;
        const { list } = scope;
        const position = list.showHints ? (hintPositions.get(row) ?? -1) : -1;
        const key = `${scopeKey}#${row.id}`;
        return (
          <div key={key} data-chat-key={key} data-offline={offline || undefined} className="contents">
            <ChatRow
              item={row}
              active={list.isActive(row)}
              collapsed={false}
              actions={actionsOf(scopeKey, scope)}
              shortcutHint={position >= 0 && position < 9 ? keys.jump(position) : undefined}
              onPick={subchat ? pickSubchatIn(scopeKey, list.onPick) : list.onPick}
              onHover={list.onHover}
              computer={list.computer}
              show={list.show}
              dimOffline
              linked={list.linkProjectId ? sidebarLinks.endsFor(scopeKey, row) : undefined}
              bot={botMarks.get(key)}
              chatKey={key}
              subchat={subchat}
              family={family}
              project={inbox ? scope.name : undefined}
              dragging={dragging === key}
              {...scope.badge}
            />
          </div>
        );
      })}
    </div>
  );
}

function ChatList({
  recents,
  scopeKey,
  isActive,
  collapsed,
  actions,
  showHints,
  onPick,
  onHover,
  linkProjectId,
  computer,
  show,
  dimOffline,
  header,
  pinnedHeader = true,
  hintOffset = 0,
  pinnedTarget,
  anyPinned = false,
  projectName,
  projectImage,
  projectInitial,
  linkProjects,
}: {
  recents: SidebarRecent[];
  /** The Project path or Link key the chats belong to. */
  scopeKey: string;
  isActive: (item: SidebarRecent) => boolean;
  collapsed: boolean;
  actions: ChatRowActions;
  showHints: boolean;
  onPick: (item: SidebarRecent) => void;
  onHover?: (item: SidebarRecent) => void;
  /** The Project's id on the canvas; null when its chats can't be linked from here. */
  linkProjectId: string | null;
  computer?: RowComputer;
  show: ChatRowShow;
  /** The rows dim themselves for an offline computer (the Pinned list; a dimmed section does it for the rest). */
  dimOffline?: boolean;
  /** The "Chats" header, between the pinned chats and the rest. */
  header: ReactNode;
  /** False when the caller shows one Pinned heading over several lists (the all-Projects sidebar). */
  pinnedHeader?: boolean;
  /** Where this list's ⌘1–9 hints start, when its chats follow others in the same Project. */
  hintOffset?: number;
  /** The all-Projects sidebar's slot in its Pinned section: the pinned rows render there, still one list, so a drag
   * moves a chat between Pinned and its group. */
  pinnedTarget?: HTMLElement | null;
  /** Another list already shows pinned rows (and the Pinned heading) in that section. */
  anyPinned?: boolean;
  /** The one-list sidebar has no Project header: each row says its Project on its second line. */
  projectName?: string;
  /** With `projectName`: the rows' Project icon, see ChatRow. */
  projectImage?: string | null;
  projectInitial?: string;
  linkProjects?: number;
}) {
  const keys = useSidebarKeys();
  const listRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const containers = () => [listRef.current, pinRef.current].filter((node): node is HTMLDivElement => !!node);
  const rowIn = (nodes: HTMLElement[], id: string) => {
    for (const container of nodes) {
      const found = container.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(id)}"]`);
      if (found) return found;
    }
    return null;
  };
  const rowElement = (id: string) => rowIn(containers(), id);
  const sidebarLinks = useSidebarLinks();
  const botMarks = useBotMarks();
  const links = sidebarLinks.links;
  const [drag, setDrag] = useState<ChatDrag | null>(null);
  const dragRef = useRef<ChatDrag | null>(null);
  const [mark, setMark] = useState<{ top: number; height: number; inPins: boolean } | null>(null);
  // A target row in another Project's list, outlined over the page.
  const [foreignMark, setForeignMark] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<string | null>(null);
  const canDrag = !collapsed && Boolean(actions.onPin);
  const pinned = recents.filter((item) => item.pinned);
  const rest = useMemo(() => recents.filter((item) => !item.pinned), [recents]);
  // Subchats sit under their parent's row, unless the sidebar is a rail of icons.
  const folds = useSubchatFolds();
  const shownRest = useMemo(
    () => (collapsed ? rest.map((item) => ({ item, subchat: false })) : shownChats(rest, { ...rowKeys(scopeKey), folded: folds, asking: subchatAsks })),
    [rest, folds, collapsed, scopeKey],
  );
  // A subchat's row opens it beside its parent.
  const openSubchat = useContext(OpenSubchatContext);
  const pickSubchat = useCallback(
    (item: SidebarRecent) => {
      if (!openSubchat?.(`${scopeKey}#${item.id}`)) onPick(item);
    },
    [openSubchat, scopeKey, onPick],
  );
  const byId = (id: string | null) => recents.find((item) => item.id === id);
  const otherList = (scope: string | undefined) => (scope === undefined ? undefined : sidebarLinks.lists().find((handle) => handle.scopeKey === scope));

  // Window listeners and memoized row actions call through this, so they always see the latest render.
  const live = useRef({ recents, actions, sidebarLinks });
  live.current = { recents, actions, sidebarLinks };
  // Keep the drag handlers separate: drop closes over rowActions below.
  const dragHandlers = useRef({ over, drop, finish, hit });
  useLayoutEffect(() => {
    dragHandlers.current = { over, drop, finish, hit };
  });

  // Another Project's list finds this one's rows when a drag from there ends here.
  useEffect(() => {
    if (!linkProjectId) return;
    const handle: LinkListHandle = { scopeKey, containers, byId: (id) => live.current.recents.find((item) => item.id === id) };
    return sidebarLinks.register(handle);
  }, [scopeKey, linkProjectId]);

  /** Beside the sidebar, level with the row the menu or the drop was on. */
  const anchorAt = (top: number) => {
    const aside = listRef.current?.closest("aside")?.getBoundingClientRect();
    return { top: Math.max(8, top), left: (aside?.right ?? 0) + 8 };
  };

  // Pinning from the row menu and from a drag both land here, so either can be undone. The Link items open the
  // shared "Link with…" and "Remove Link with…" lists.
  const rowActions = useMemo(() => chatRowActions(actions, linkProjectId, scopeKey, () => live.current), [actions, linkProjectId, scopeKey, live]);

  const endpoint = (item: SidebarRecent) => ({ pinned: item.pinned, worktree: item.details?.path });
  const linkedTo = (a: SidebarRecent, b: SidebarRecent, bProject: string | null) =>
    !!linkProjectId &&
    !!bProject &&
    !!a.details?.path &&
    !!b.details?.path &&
    !!linkBetween(links, { project_id: linkProjectId, worktree_path: a.details.path }, { project_id: bProject, worktree_path: b.details.path });

  /** The chat a target names, in this list or another Project's, with that list's Project id. */
  function targetChat(target: DropTarget) {
    if (target.scope === undefined) return { onto: target.id === null ? null : byId(target.id), projectId: linkProjectId };
    const handle = otherList(target.scope);
    return { onto: handle && target.id !== null ? handle.byId(target.id) : undefined, projectId: handle ? sidebarLinks.projectIdOf(handle.scopeKey) : null };
  }

  function intentOf(current: ChatDrag): DropIntent {
    const source = byId(current.id);
    const target = current.target;
    if (!source || !target || (target.id === current.id && target.scope === undefined)) return "none";
    const { onto, projectId } = targetChat(target);
    if (onto === undefined || onto?.pending) return "none";
    if (target.zone === "on" && !(source.details?.path && onto?.details?.path)) return "none";
    // Two Projects' Worktrees are never the same one, whatever their paths say.
    const sameProject = target.scope === undefined;
    return dropIntent(
      endpoint(source),
      onto && (sameProject ? endpoint(onto) : { pinned: onto.pinned }),
      target.zone,
      Boolean(onto && linkedTo(source, onto, projectId)),
    );
  }

  /** The pinned chats other than the dragged one, and the index the drop puts it at among them. */
  function pinSlot(current: ChatDrag) {
    const others = recents.filter((item) => item.pinned && item.id !== current.id);
    const target = current.target;
    const index = !target?.id ? 0 : others.findIndex((item) => item.id === target.id) + (target.zone === "after" ? 1 : 0);
    return { orders: others.map((item) => item.pinOrder ?? 0), index };
  }

  function describe(current: ChatDrag) {
    const intent = intentOf(current);
    if (typeof intent === "object") return DROP_HINTS[intent.invalid];
    if (intent === "link") return `On ${current.target && targetChat(current.target).onto?.label}: create Link`;
    if (intent === "pin" || intent === "reorder") {
      const { orders, index } = pinSlot(current);
      return `Pinned, position ${index + 1} of ${orders.length + 1}`;
    }
    return intent === "unpin" ? "Chats: unpin" : "No change";
  }

  function setDragState(next: ChatDrag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function begin(id: string, keyboard: boolean) {
    setDragState({ id, target: null, keyboard });
    document.documentElement.setAttribute("data-chat-drag", "");
    if (!keyboard) {
      // The press that started the drag would otherwise select the labels it moves over.
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    // Read as the drag starts, so "Already linked" follows Links drawn on the canvas since.
    if (linkProjectId) sidebarLinks.refresh();
    setAnnouncement(keyboard ? `Picked up ${byId(id)?.label}. Arrow keys move it, Space drops it, Escape cancels.` : "");
  }

  function finish() {
    setDragState(null);
    document.documentElement.removeAttribute("data-chat-drag");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function over(target: DropTarget | null) {
    const current = dragRef.current;
    if (!current || sameTarget(current.target, target)) return;
    const next = { ...current, target };
    setDragState(next);
    if (current.keyboard) setAnnouncement(target ? describe(next) : "");
  }

  function drop() {
    const current = dragRef.current;
    finish();
    if (!current) return;
    const intent = intentOf(current);
    if (current.keyboard) {
      refocus.current = current.id;
      window.setTimeout(() => {
        refocus.current = null;
      }, 1000);
      setAnnouncement(
        typeof intent === "object"
          ? DROP_HINTS[intent.invalid]
          : intent === "none"
            ? "Dropped, nothing changed"
            : intent === "link"
              ? ""
              : `Dropped. ${describe(current)}`,
      );
    }
    if (intent === "pin" || intent === "reorder") {
      const { orders, index } = pinSlot(current);
      rowActions.onPin?.(current.id, pinOrderAt(orders, index));
    } else if (intent === "unpin") rowActions.onPin?.(current.id, null);
    else if (intent === "link" && current.target) {
      const source = byId(current.id)!;
      const { onto } = targetChat(current.target);
      const scope = current.target.scope ?? scopeKey;
      const element = current.target.scope === undefined ? rowElement(onto!.id) : rowIn(otherList(scope)?.containers() ?? [], onto!.id);
      sidebarLinks.ask({ scopeKey, item: source }, { scopeKey: scope, item: onto! }, anchorAt(element?.getBoundingClientRect().top ?? 8));
    }
  }

  /** The row or empty Pinned section under the pointer; between two rows it keeps the last one. */
  function hit(x: number, y: number): DropTarget | null {
    const inside = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };
    const within = containers().filter(inside);
    if (!within.length) return linkProjectId ? otherHit(x, y, inside) : null;
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chat-id], [data-pin-zone]");
    if (!element || !within.some((node) => node.contains(element)))
      return dragRef.current?.target?.scope === undefined ? (dragRef.current?.target ?? null) : null;
    if (element.hasAttribute("data-pin-zone")) return { id: null, zone: "before" };
    const rect = element.getBoundingClientRect();
    const at = (y - rect.top) / rect.height;
    const zone: DropZone = linkProjectId ? (at < 1 / 3 ? "before" : at > 2 / 3 ? "after" : "on") : at < 0.5 ? "before" : "after";
    return { id: element.dataset.chatId ?? null, zone };
  }

  /** A row of another Project's list under the pointer: anywhere on it links, since the drop can't move the chat there. */
  function otherHit(x: number, y: number, inside: (node: HTMLElement) => boolean): DropTarget | null {
    for (const handle of sidebarLinks.lists()) {
      if (handle.scopeKey === scopeKey) continue;
      const nodes = handle.containers().filter(inside);
      if (!nodes.length) continue;
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chat-id]");
      if (!element || !nodes.some((node) => node.contains(element))) return null;
      return { id: element.dataset.chatId ?? null, zone: "on", scope: handle.scopeKey };
    }
    return null;
  }

  function startPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canDrag || event.button !== 0 || dragRef.current) return;
    const pressed = event.target as HTMLElement;
    const row = pressed.closest<HTMLElement>("[data-chat-id]");
    const id = row?.dataset.chatId;
    if (!id || pressed.closest("a, input, [aria-haspopup]") || byId(id)?.pending) return;
    const start = { x: event.clientX, y: event.clientY };
    let started = false;
    // Past the sidebar's lists, the Chat view takes the drop: beside a grid tile, or beside the Chat on screen. Named
    // Link Chats stay out of the grid.
    const key = isLinkScopeKey(scopeKey) ? null : `${scopeKey}#${id}`;
    let onGrid: GridDropTarget | null = null;
    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
        started = true;
        begin(id, false);
      }
      // Escape called the drag off: the rest of the press does nothing.
      if (!dragRef.current) return;
      const target = dragHandlers.current.hit(moveEvent.clientX, moveEvent.clientY);
      onGrid = !target && key ? gridDrop.hit(moveEvent.clientX, moveEvent.clientY, key) : null;
      gridDrop.show(onGrid);
      dragHandlers.current.over(target);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
    };
    const end = () => {
      stop();
      if (!started) return;
      // The press still ends in a click; it was a drag, so that click doesn't open a chat.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      if (!dragRef.current) return;
      if (onGrid && key) {
        dragHandlers.current.finish();
        gridDrop.drop(key, onGrid);
      } else dragHandlers.current.drop();
    };
    const cancel = () => {
      stop();
      gridDrop.show(null);
      if (started) dragHandlers.current.finish();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  }

  // Escape cancels a pointer drag; the keyboard drag handles its own keys on the row.
  useEffect(() => {
    if (!drag || drag.keyboard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      gridDrop.show(null);
      dragHandlers.current.finish();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag?.id, drag?.keyboard]);

  /** Every place the keyboard can move a chat to, top to bottom. */
  function slots(id: string): DropTarget[] {
    const others = recents.filter((item) => item.id !== id && !item.pending);
    const pins = others.filter((item) => item.pinned);
    const around = (item: SidebarRecent): DropTarget[] =>
      linkProjectId
        ? [
            { id: item.id, zone: "before" },
            { id: item.id, zone: "on" },
          ]
        : [{ id: item.id, zone: "before" }];
    const top: DropTarget[] = pins.length
      ? [...pins.flatMap(around), { id: pins.at(-1)!.id, zone: "after" }]
      : byId(id)?.pinned
        ? []
        : [{ id: null, zone: "before" }];
    return [...top, ...others.filter((item) => !item.pinned).flatMap(around)];
  }

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = dragRef.current;
    const pressed = event.target as HTMLElement;
    if (!current) {
      const id = pressed.closest<HTMLElement>("[data-chat-id]")?.dataset.chatId;
      if (event.key !== " " || !canDrag || !id || !pressed.matches("[data-row]") || byId(id)?.pending) return;
      event.preventDefault();
      begin(id, true);
      return;
    }
    if (!current.keyboard) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const all = slots(current.id);
      if (!all.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      const index = all.findIndex((slot) => sameTarget(slot, current.target));
      over(all[index === -1 ? (step > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, index + step))] ?? null);
    } else if (event.key === " ") {
      event.preventDefault();
      drop();
    } else if (event.key === "Escape") {
      // Consumed here, so Escape doesn't also stop the open chat's turn.
      event.preventDefault();
      finish();
      setAnnouncement("Cancelled");
    } else if (event.key === "Tab") finish();
  }

  // Space on a row picks it up instead of opening it; Enter still opens it.
  const keyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " && canDrag && (event.target as HTMLElement).matches("[data-row]")) event.preventDefault();
  };

  // The line or highlight follows the target row, measured once the Pinned drop area has shown up. A row in another
  // Project's list is outlined over the page instead.
  const targetId = drag?.target?.id;
  const targetScope = drag?.target?.scope;
  useLayoutEffect(() => {
    if (targetScope !== undefined) {
      setMark(null);
      const row = targetId ? rowIn(otherList(targetScope)?.containers() ?? [], targetId) : null;
      const rect = row?.getBoundingClientRect();
      setForeignMark(rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null);
      return;
    }
    setForeignMark(null);
    const row = targetId ? rowElement(targetId) : null;
    const inPins = !!row && !!pinRef.current?.contains(row);
    const container = inPins ? pinRef.current : listRef.current;
    if (!container || !row) return setMark(null);
    const box = container.getBoundingClientRect(),
      rect = row.getBoundingClientRect();
    setMark({ top: rect.top - box.top, height: rect.height, inPins });
  }, [targetId, targetScope, recents]);

  // A row moved by the keyboard comes back in its new place; focus goes back to it.
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id || containers().some((node) => node.contains(document.activeElement))) return;
    rowElement(id)?.querySelector<HTMLElement>("[data-row]")?.focus();
  }, [recents]);

  const intent = drag ? intentOf(drag) : "none";
  const row = (item: SidebarRecent, index: number, shown?: ShownRow) => (
    <ChatRow
      key={item.id}
      item={item}
      subchat={shown?.subchat}
      family={shown?.family}
      onPick={shown?.subchat ? pickSubchat : onPick}
      active={isActive(item)}
      collapsed={collapsed}
      actions={rowActions}
      shortcutHint={showHints && hintOffset + index < 9 ? keys.jump(hintOffset + index) : undefined}
      onHover={onHover}
      // The all-Projects sidebar names the computer in the Project's header; only its pinned rows, away from it, say it.
      computer={pinnedTarget !== undefined && !item.pinned ? undefined : computer}
      show={show}
      dimOffline={dimOffline || (Boolean(pinnedTarget) && Boolean(item.pinned))}
      dragging={drag?.id === item.id}
      linked={linkProjectId ? sidebarLinks.endsFor(scopeKey, item) : undefined}
      bot={botMarks.get(`${scopeKey}#${item.id}`)}
      chatKey={`${scopeKey}#${item.id}`}
      project={projectName}
      projectImage={projectImage}
      projectInitial={projectInitial}
      linkProjects={linkProjects}
    />
  );

  const target = (invalid: boolean, hint: string | null) => (
    <>
      {invalid && hint ? (
        <span className="absolute left-0 top-full z-40 mt-1 rounded-[6px] bg-surface px-2 py-1 text-[11.5px] text-red-ink shadow-overlay">{hint}</span>
      ) : (
        <HugeIcon icon={Link04Icon} size={14} />
      )}
    </>
  );
  const targetClass = (invalid: boolean) =>
    `pointer-events-none z-30 flex items-center justify-end rounded-[8px] pr-2 ring-2 ${invalid ? "bg-red/5 ring-red/60" : "bg-accent/10 text-accent ring-accent"}`;
  const indicator = (inPins: boolean) =>
    mark?.inPins === inPins &&
    drag?.target?.id &&
    drag.target.scope === undefined &&
    mark &&
    intent !== "none" &&
    (drag.target.zone === "on" ? (
      <div
        data-drop-target={typeof intent === "object" ? "invalid" : "link"}
        className={`absolute inset-x-2 ${targetClass(typeof intent === "object")}`}
        style={{ top: mark.top, height: mark.height }}
      >
        {target(typeof intent === "object", typeof intent === "object" ? DROP_HINTS[intent.invalid] : null)}
      </div>
    ) : (
      <div
        data-drop-line
        className="pointer-events-none absolute inset-x-3 z-30 h-0.5 -translate-y-1/2 rounded-full bg-accent"
        style={{ top: drag.target.zone === "before" ? mark.top : mark.top + mark.height }}
      />
    ));
  const foreignIndicator =
    foreignMark &&
    drag?.target?.scope !== undefined &&
    intent !== "none" &&
    createPortal(
      <div
        data-drop-target={typeof intent === "object" ? "invalid" : "link"}
        data-drop-scope={drag.target.scope}
        className={`fixed ${targetClass(typeof intent === "object")}`}
        style={{ top: foreignMark.top, left: foreignMark.left + 8, width: foreignMark.width - 16, height: foreignMark.height }}
      >
        {target(typeof intent === "object", typeof intent === "object" ? DROP_HINTS[intent.invalid] : null)}
      </div>,
      document.body,
    );
  // In its slot of the all-Projects Pinned section, the Pinned heading belongs to the section; while a chat is dragged
  // and nothing is pinned anywhere, the slot shows it with the drop area.
  const pinnedRows = pinnedTarget ? (
    <div ref={pinRef} data-chat-list-pins data-chat-scope={scopeKey} className="relative">
      {drag && pinned.length === 0 && !anyPinned && !collapsed && (
        <div className="sidebar-copy mx-2 mb-1 flex h-8 items-center pl-2">
          <span className="text-[12.5px] font-medium text-ink-3">Pinned</span>
        </div>
      )}
      {drag && pinned.length === 0 && !collapsed && (
        <div
          data-pin-zone
          className={`mx-2 mb-1 flex h-8 items-center justify-center rounded-[8px] border border-dashed text-[12.5px] ${drag.target?.id === null ? "border-accent bg-accent/10 text-accent-ink" : "border-line-strong text-ink-3"}`}
        >
          Drop here to pin
        </div>
      )}
      {pinned.length > 0 && (
        <div data-pinned-chats className="flex flex-col gap-px">
          {pinned.map((item, index) => row(item, index))}
        </div>
      )}
      {indicator(true)}
    </div>
  ) : null;

  return (
    <div ref={listRef} data-chat-list data-chat-scope={scopeKey} className="relative" onPointerDown={startPointer} onKeyDown={keyDown} onKeyUp={keyUp}>
      {/* A portal still bubbles its React events here, so the pointer and keys of pinned rows reach this list. */}
      {pinnedTarget ? (
        createPortal(pinnedRows, pinnedTarget)
      ) : (
        <>
          {pinnedHeader && (pinned.length > 0 || drag) && !collapsed && (
            <div className="sidebar-copy mx-2 mb-1 flex h-8 items-center pl-2">
              <span className="text-[12.5px] font-medium text-ink-3">Pinned</span>
            </div>
          )}
          {drag && pinned.length === 0 && !collapsed && (
            <div
              data-pin-zone
              className={`mx-2 mb-1 flex h-8 items-center justify-center rounded-[8px] border border-dashed text-[12.5px] ${drag.target?.id === null ? "border-accent bg-accent/10 text-accent-ink" : "border-line-strong text-ink-3"}`}
            >
              Drop here to pin
            </div>
          )}
          {pinned.length > 0 && (
            <div data-pinned-chats className="mb-2">
              <div className="flex flex-col gap-px">{pinned.map((item, index) => row(item, index))}</div>
            </div>
          )}
        </>
      )}
      {collapsed && pinned.length > 0 && <div className="mx-auto mb-2 h-px w-5 bg-line" />}
      {header}
      <div className="flex flex-col gap-px">{shownRest.map((shown, index) => row(shown.item, pinned.length + index, shown))}</div>

      {indicator(false)}
      {foreignIndicator}

      <div aria-live="assertive" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
