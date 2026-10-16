import type { NamedProjectLink } from "@milagre/shared/model";
import { ProjectAvatarStack } from "./ProjectAvatarStack";
import { useWindowChrome } from "../lib/window-chrome";
import { ResizeHandle } from "./primitives/ResizeHandle";
import { useProjectImages } from "../lib/project-images";

import {
  Fragment,
  memo,
  useCallback,
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
  Cancel01Icon,
  Copy01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GitMergeIcon,
  Link04Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  Search01Icon,
  Settings01Icon,
  SidebarLeft01Icon,
  SidebarRight01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { ChatRowShow } from "@milagre/shared/chat-row";
import { FiltersButton, type PickerProject } from "./sidebar/FiltersMenu";
import { shortcutModifier, useShortcutHints } from "../lib/shortcut-hints";
import { ScrollArea } from "./primitives/ScrollArea";
import { projectMenuActions, type ProjectMenuKey } from "@/lib/reveal";
import { projectRows, stableOrder, type ProjectRow, type RecentProject } from "@/lib/project-list";
import { ComputersButton } from "./sidebar/ComputersButton";
import { ChatRow, type ChatRowActions, type RowComputer, type SidebarRecent } from "./sidebar/ChatRow";
import { useComputers, isDimmed } from "../lib/computers";
import { mergeScopes, useComputerScopes, withoutLocal } from "../lib/computer-scopes";
import { LOCAL_COMPUTER, computerOfKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { useDismiss } from "../lib/use-dismiss";
import { dropIntent, pinOrderAt, type DropIntent, type DropZone } from "@/lib/chat-list";
import { linkBetween } from "@milagre/shared/chat-links";
import { SidebarLinksProvider, useSidebarLinks, type LinkListHandle, type LinkScopeChats } from "./sidebar/SidebarLinks";
import { updateSettings, useSettings } from "../lib/settings";
import { UpdateSettingsBadge } from "./UpdateNotice";
import { RECENT_PROJECTS_CHANGED } from "../lib/project-list";
import { cachedProjectCopy, railLive, rememberScopeRows, scopeChats, useScopeStates } from "../lib/sidebar-scopes";
import { ScopeRail, type RailScope } from "./sidebar/ScopeRail";
import { bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { MODEL_CATALOG, type ModelOption } from "../model";
import { useBots } from "../lib/bots-store";
import { BotMarksContext, botMarks as botMarksOf, useBotMarks } from "../lib/bot-marks";
import { SidebarModeSwitch, type SidebarMode } from "./bots/SidebarModeSwitch";
import { BotList, NewBotButton } from "./bots/BotList";
import { NewBotSheet } from "./bots/NewBotSheet";

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

const IconCheckmark1Small = (props: HugeIconProps) => <HugeIcon icon={Tick02Icon} {...props} />;
const IconChevronDownSmall = (props: HugeIconProps) => <HugeIcon icon={ArrowDown01Icon} {...props} />;
const IconCrossSmall = (props: HugeIconProps) => <HugeIcon icon={Cancel01Icon} {...props} />;
const IconFolderAdd = (props: HugeIconProps) => <HugeIcon icon={FolderAddIcon} {...props} />;
const IconMagnifyingGlass = (props: HugeIconProps) => <HugeIcon icon={Search01Icon} {...props} />;
const IconPlusMedium = (props: HugeIconProps) => <HugeIcon icon={Add01Icon} {...props} />;
const IconPopsicle2 = (props: HugeIconProps) => <HugeIcon icon={SparklesIcon} {...props} />;
const IconSettingsGear1 = (props: HugeIconProps) => <HugeIcon icon={Settings01Icon} {...props} />;

/* ─────────────────────────────────────────────────────────
 * SIDEBAR NAV
 * Shared by the design-system preview and the harness shell.
 * Default: a project menu at the top, then primary navigation,
 * searchable chat history, and a collapse that preserves icon
 * alignment. By default (Settings › Experimental › Use legacy sidebar off): every
 * Project and Link listed with its chats instead of the menu.
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
  onPick?: (id: string, label: string, prompt?: string) => void;
  onOpenSettings?: () => void;
  onOpenCanvas?: () => void;
  canvasActive?: boolean;
  onOpenCommands?: () => void;
  hintsEnabled?: boolean;
  /** The project folder, for the project menu's reveal and copy path. */
  projectPath?: string;
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
  /** "Link and ask A…": sends the message to that chat (its Project path and id) through the normal send path. */
  onAskChat?: (scopeKey: string, id: string, message: { body: string; prompt: string }) => Promise<unknown>;
  /** Projects or Bots; the switch shows only while Bots is on (Settings › Experimental) and this is given. */
  sidebarMode?: SidebarMode;
  onSidebarMode?: (mode: SidebarMode) => void;
  selectedBotId?: string | null;
  onPickBot?: (id: string) => void;
  /** The models New bot offers, and the one it starts on. */
  models?: ModelOption[];
  defaultModel?: ModelOption;
};

const NO_CHAT_ACTIONS: ChatRowActions = {};
const NEVER_ACTIVE = () => false;
// Groups of the all-Projects sidebar the user folded, by Project path or Link key; the rest stay open.
const CLOSED_SCOPES_KEY = "milagre.sidebarClosedScopes";
function readClosedScopes(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CLOSED_SCOPES_KEY) ?? "[]");
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
    const raw = window.localStorage.getItem(SCOPE_ORDER_KEY) ?? "[]";
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
    window.localStorage.setItem(SCOPE_ORDER_KEY, next);
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

/** A Project or Link heading in the sidebar: folds its chats. Hovered, the chevron takes the icon's place, as in Paseo; the ⋯ menu and the + sit on the right. */
function ScopeHeader({
  name,
  icon,
  open,
  current,
  attention,
  onToggle,
  onNewChat,
  menu,
}: {
  name: string;
  icon: ReactNode;
  open: boolean;
  current: boolean;
  attention: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  /** The ⋯ menu's rows; none hides the button. */
  menu: ScopeMenuItem[];
}) {
  return (
    <div className="group/scope relative mx-2 flex h-8 items-center">
      <button
        type="button"
        data-scope-toggle
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
        onClick={onToggle}
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] pl-2 pr-[60px] text-left hover:bg-hover-2"
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
        <span data-scope-name className={`min-w-0 flex-1 truncate text-[13px] ${current ? "font-medium text-ink" : "text-ink-2"}`}>
          {name}
        </span>
      </button>
      {/* Rests at the right edge; slides left when hover reveals the actions it would sit under. */}
      {attention && (
        <AttentionDot
          className={`pointer-events-none absolute right-3 transition-transform duration-150 ease-out ${menu.length > 0 ? "group-hover/scope:-translate-x-[52px] group-has-[:focus-visible]/scope:-translate-x-[52px]" : "group-hover/scope:-translate-x-[26px] group-has-[:focus-visible]/scope:-translate-x-[26px]"}`}
        />
      )}
      <div className="absolute right-1 flex items-center gap-0.5">
        {menu.length > 0 && <ScopeMenuButton name={name} items={menu} />}
        <Tooltip label="New chat" shortcut={current ? "⌘N" : undefined} align="end">
          <button
            type="button"
            data-scope-action
            aria-label={current ? "New chat" : `New chat in ${name}`}
            onClick={onNewChat}
            className={`${SCOPE_HEADER_BUTTON} ${current ? "" : "opacity-0 group-hover/scope:opacity-100 focus-visible:opacity-100"}`}
          >
            <IconPlusMedium size={14} />
          </button>
        </Tooltip>
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
                      <span className={`min-w-0 flex-1 truncate text-[13.5px] ${item.destructive ? "text-red" : "text-ink"}`}>{item.label}</span>
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
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
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
      <span className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[15px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>{label}</span>
      {count && <span className="sidebar-copy mr-2 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{count}</span>}
    </button>
  );
}

function WorkspaceMenu({
  position,
  onClose,
  workspace,
  projectPath,
  onOpenProjectSettings,
  projects,
  onSwitchProject,
  onOpenProject,
  onForgetProject,
  selectedLink,
  links,
  registeredProjects,
  onSwitchLink,
  onLinkProject,
  onEditLink,
  attentionPaths,
}: {
  position: { top: number; left: number };
  onClose: () => void;
  workspace: { name: string; monogram: string; image?: string | null };
  projectPath?: string;
  onOpenProjectSettings?: (path: string) => void;
  projects: ProjectRow[];
  onSwitchProject?: (path: string) => void;
  onOpenProject?: () => void;
  onForgetProject?: (path: string) => void;
  selectedLink?: SidebarNavProps["selectedLink"];
  links: NamedProjectLink[];
  registeredProjects: Array<{ id: string; path: string; name: string }>;
  onSwitchLink?: (id: string) => void;
  onLinkProject?: () => void;
  onEditLink?: (id: string) => void;
  attentionPaths: string[];
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const imageOf = useProjectImages(projects.filter((row) => !row.current).map((row) => row.path));
  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[data-menu-row]:not(:disabled)")?.focus();
  }, []);

  // Switching projects stops nothing: the other project's turns keep running in the background.
  const go = (open: () => void) => {
    onClose();
    open();
  };
  // Focus inside the row (its own button, or the × just clicked) moves to a neighbour before the row goes,
  // so the arrow keys keep working.
  const forget = (path: string, item: HTMLElement | null) => {
    if (item?.contains(document.activeElement)) {
      const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
      const index = rows.findIndex((row) => item.contains(row));
      (rows[index + 1] ?? rows[index - 1])?.focus();
    }
    onForgetProject?.(path);
  };

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(index + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});
  const projectActions: Record<ProjectMenuKey, { run: () => void; disabled: boolean }> = {
    reveal: { run: () => void window.milagre?.revealInFolder(projectPath ?? "").catch(() => {}), disabled: !projectPath },
    "copy-path": { run: () => copy(unqualifyKey(projectPath ?? "")), disabled: !projectPath },
    "copy-name": { run: () => copy(workspace.name), disabled: false },
    settings: { run: () => onOpenProjectSettings?.(projectPath ?? ""), disabled: !onOpenProjectSettings || !projectPath },
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${workspace.name} actions`}
      onKeyDown={moveFocus}
      data-workspace-menu
      className="fixed z-50 flex max-h-[calc(100vh-16px)] w-64 flex-col overflow-hidden rounded-[14px] bg-surface shadow-overlay"
      style={{
        top: position.top,
        left: position.left,
        animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
        transformOrigin: "top left",
      }}
    >
      <ScrollArea className="p-1.5">
        <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
          {!selectedLink &&
            projectMenuActions(IS_MAC)
              .filter((item) => item.key !== "reveal" || !isRemoteKey(projectPath))
              .map((item) => (
                <button
                  key={item.key}
                  data-menu-row
                  data-project-action={item.key}
                  role="menuitem"
                  type="button"
                  disabled={projectActions[item.key].disabled}
                  onClick={() => {
                    onClose();
                    projectActions[item.key].run();
                  }}
                  className="relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2 disabled:opacity-40"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
                    <HugeIcon icon={PROJECT_MENU_ICONS[item.key]} size={16} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.label}</span>
                </button>
              ))}
          {!selectedLink && <div className="my-1 h-px bg-line" />}
          <p className="px-2 py-1 text-[11px] font-medium text-ink-3">Projects</p>
          {projects.map((row) => {
            return (
              <div key={row.path} data-project-item className="group/project relative">
                <button
                  data-menu-row
                  data-project-row={row.path}
                  role="menuitemradio"
                  aria-checked={row.current}
                  type="button"
                  title={row.current ? row.path : `${row.path}\nPress Delete to remove from the list`}
                  {...(row.current ? {} : { "aria-keyshortcuts": "Delete" })}
                  onClick={() => (row.current ? onClose() : go(() => onSwitchProject?.(row.path)))}
                  onKeyDown={(event) => {
                    if (row.current || (event.key !== "Delete" && event.key !== "Backspace")) return;
                    event.preventDefault();
                    forget(row.path, event.currentTarget.closest("[data-project-item]"));
                  }}
                  className="relative z-10 flex h-10 w-full items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink text-[11px] font-semibold text-surface">
                    <WorkspaceIcon src={row.current ? workspace.image : imageOf(row.path)} fallback={row.initial} />
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-[13.5px] text-ink ${row.current ? "font-medium" : "group-hover/project:pr-6"}`}>
                    {row.name}
                  </span>
                  {row.current && (
                    <span className="shrink-0 text-ink">
                      <IconCheckmark1Small size={18} />
                    </span>
                  )}
                  {!row.current && attentionPaths.includes(row.path) && <AttentionDot className="mr-1 group-hover/project:opacity-0" />}
                </button>
                {!row.current && (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-forget-project={row.path}
                    aria-label={`Remove ${row.name} from the list`}
                    title="Remove from the list"
                    onClick={(event) => forget(row.path, event.currentTarget.closest("[data-project-item]"))}
                    className="absolute right-1.5 top-2 z-20 flex size-6 items-center justify-center rounded-[6px] text-ink-3 opacity-0 transition-[opacity,background-color,color] duration-100 hover:bg-hover hover:text-ink group-hover/project:opacity-100"
                  >
                    <IconCrossSmall size={14} />
                  </button>
                )}
              </div>
            );
          })}
          {links.length > 0 && (
            <>
              <div className="my-1 h-px bg-line" />
              <p className="px-2 py-1 text-[11px] font-medium text-ink-3">Links</p>
              {links.map((link) => (
                <button
                  key={link.id}
                  data-menu-row
                  data-link-row={link.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedLink?.id === link.id}
                  onClick={() => go(() => onSwitchLink?.(link.id))}
                  className="relative z-10 flex min-h-10 items-center gap-2 rounded-[8px] px-2 py-1 text-left outline-none focus-visible:bg-hover-2"
                >
                  <ProjectAvatarStack
                    projects={link.projectIds.map((id) => registeredProjects.find((project) => project.id === id) ?? { path: "", name: "Project" })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-ink">{link.name}</span>
                    <span className="block text-[11px] text-ink-3">{link.projectIds.length} Projects</span>
                  </span>
                  {selectedLink?.id === link.id && <IconCheckmark1Small size={18} />}
                </button>
              ))}
            </>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            data-menu-row
            data-open-project
            role="menuitem"
            type="button"
            onClick={() => go(() => onOpenProject?.())}
            className="relative z-10 flex h-9 w-full items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2"
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
              <IconPlusMedium size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">Open project…</span>
          </button>
          {onLinkProject && (
            <button
              data-menu-row
              type="button"
              role="menuitem"
              onClick={() => go(onLinkProject)}
              className="relative z-10 flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2"
            >
              <span className="flex size-5 items-center justify-center text-ink-2">
                <HugeIcon icon={Link04Icon} size={16} />
              </span>
              <span className="text-[13.5px]">Link projects…</span>
            </button>
          )}
          {selectedLink && onEditLink && (
            <button
              data-menu-row
              data-edit-link
              type="button"
              role="menuitem"
              onClick={() => go(() => onEditLink(selectedLink.id))}
              className="relative z-10 flex h-9 items-center gap-1.5 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2"
            >
              <span className="flex size-5 items-center justify-center text-ink-2">
                <HugeIcon icon={PencilEdit02Icon} size={16} />
              </span>
              <span className="text-[13.5px]">Edit Link…</span>
            </button>
          )}
        </GlideMenu>
      </ScrollArea>
    </div>,
    document.body,
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
  onPick,
  onOpenSettings,
  onOpenCanvas,
  canvasActive = false,
  onOpenCommands,
  hintsEnabled = true,
  projectPath,
  onOpenProjectSettings,
  attentionPaths = NO_PATHS,
  recents = DEFAULT_RECENTS,
  chatActions = NO_CHAT_ACTIONS,
  usage,
  runningKeys = "",
  waitingKeys = "",
  askingKeys = "",
  onOpenScopeChat,
  onNewChatInScope,
  onAskChat,
  sidebarMode = "projects",
  onSidebarMode,
  selectedBotId = null,
  onPickBot,
  models = MODEL_CATALOG,
  defaultModel,
}: SidebarNavProps) {
  const { legacySidebar, chatOrder, chatRowShow } = useSettings();
  // Other computers (Settings › Experimental): their Projects join the list, and every row says its computer.
  const { thisMac, computers } = useComputers();
  const remote = useComputerScopes(computers);
  const remoteScopes = remote.scopes;
  const multi = computers.length > 0;
  const everyProject = !legacySidebar || multi;
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
    if (!made) rowComputers.current.set(cacheKey, (made = { name, offline }));
    return made;
  };
  const [listsChanged, setListsChanged] = useState(0);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(AUTO_COLLAPSE_QUERY).matches);
  // True only while the sidebar is collapsed because the window got narrow, so widening it brings the sidebar back.
  const autoCollapsed = useRef(collapsed);
  const [expandedWidth, setExpandedWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [demoActiveTitle, setDemoActiveTitle] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspacePosition, setWorkspacePosition] = useState({ top: 0, left: 0 });
  const [namedLinks, setNamedLinks] = useState(() => lastLists.links);
  const [registeredProjects, setRegisteredProjects] = useState(() => lastLists.registered);
  const [recentProjects, setRecentProjects] = useState(() => lastLists.recent);
  const [recentLoaded, setRecentLoaded] = useState(() => lastLists.recentLoaded);
  // The Projects' group order, saved across restarts and windows; see stableOrder.
  const scopeOrder = useRef<string[]>(lastLists.order ?? readScopeOrder());
  const showHints = useShortcutHints() && hintsEnabled && !workspaceOpen;
  const bots = useBots();
  const botsOn = bots.enabled && onSidebarMode !== undefined;
  const botsMode = botsOn && sidebarMode === "bots";
  const botMarks = useMemo(() => botMarksOf(bots.snapshot), [bots.snapshot]);
  const [newBotOpen, setNewBotOpen] = useState(false);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);

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
  }, [projectPath, workspaceOpen, selectedLink?.id, everyProject, listsChanged]);
  useEffect(() => {
    const changed = () => setListsChanged((count) => count + 1);
    window.addEventListener(RECENT_PROJECTS_CHANGED, changed);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED, changed);
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
  const currentKey = selectedLink ? `milagre-link:${selectedLink.id}` : (projectPath ?? "");
  const projectScopes = projects
    .filter((row) => row.current || !recentProjects.find((project) => project.path === row.path)?.hidden)
    .map((row) => ({ key: row.path, name: row.name, initial: row.initial, link: null as NamedProjectLink | null, computerId: computerOfKey(row.path) }));
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
      .filter((link) => link.id === selectedLink?.id || !link.hidden)
      .map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId: LOCAL_COMPUTER })),
  ];
  // With other computers, one list by name (their order can't follow this Mac's open history); with this Mac alone, as before.
  const scopes = multi
    ? mergeScopes(
        // The open Project of another computer is already among the local ones, under its qualified key.
        [...localScopes, ...withoutLocal(remoteScopes, localScopes)],
        computers.map((computer) => computer.id),
      )
    : localScopes;
  // Every Project, hidden ones too, since the project chooser lists them all.
  const scopeImage = useProjectImages(
    everyProject ? [...projects.map((row) => row.path), ...remoteScopes.filter((scope) => !scope.link).map((scope) => scope.key)] : NO_PATHS,
  );
  const showAll = everyProject && !collapsed;
  const {
    states: scopeStates,
    failed: failedScopes,
    retry: retryScope,
  } = useScopeStates(
    // Collapsed too: the rail's icons show each scope's chats' state and list the live ones.
    everyProject,
    scopes.filter((scope) => scope.key !== currentKey).map((scope) => scope.key),
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
  // Another Project's or Link's chats can be pinned from here; the row menu's other actions stay with the open one.
  // One object per scope, so its rows keep their memo.
  const scopeActions = useRef(new Map<string, ChatRowActions>());
  const actionsFor = (key: string) => {
    let actions = scopeActions.current.get(key);
    if (!actions) {
      actions = {
        remote: isRemoteKey(key),
        onPin: (id, order) =>
          void bridgeForKey(key)
            .patchChat(key, Number(id), order == null ? { pinned: false, pin_order: undefined } : { pinned: true, pin_order: order })
            .catch(() => {}),
      };
      scopeActions.current.set(key, actions);
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
  // Canvas Links join this Mac's Projects: a Named Link's shared chats and another computer's take none.
  const linkProjectIdOf = (key: string | undefined) =>
    key && !key.startsWith("milagre-link:") && !isRemoteKey(key) ? (registeredProjects.find((project) => project.path === key)?.id ?? null) : null;
  const groups = showAll
    ? scopes.map((scope) => {
        const current = scope.key === currentKey;
        // The Project just left has no read of its own yet; the copy it was shown from fills in until one arrives.
        const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
        const rows = current ? recents : state ? scopeChats(scope.key, state, chatOrder, marks) : [];
        const list = current
          ? {
              isActive: (item: SidebarRecent) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle),
              collapsed: false,
              actions: chatActions,
              showHints,
              onPick: pickChat,
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
        };
      })
    : [];
  // Collapsed with two or more scopes: one icon per scope instead of the open one's chat initials.
  const scopeIcon = (scope: (typeof scopes)[number], current: boolean) =>
    scope.link ? (
      <ProjectAvatarStack
        projects={scope.link.projectIds.map((id) => registeredProjects.find((project) => project.id === id) ?? { path: "", name: "Project" })}
      />
    ) : (
      <span className="flex size-6 items-center justify-center overflow-hidden rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
        <WorkspaceIcon src={current && !selectedLink ? workspace.image : scopeImage(scope.key)} fallback={scope.initial} />
      </span>
    );
  const railScopes: RailScope[] | null =
    everyProject && collapsed && scopes.length > 1
      ? scopes.map((scope) => {
          const current = scope.key === currentKey;
          const state = scopeStates[scope.key] ?? (scope.link ? undefined : cachedProjectCopy(scope.key)?.state);
          const rows = current ? recents : state ? scopeChats(scope.key, state, chatOrder, marks) : [];
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
  const anyPinned = groups.some((group) => group.pinned.length > 0);
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
      window.localStorage.setItem(CLOSED_SCOPES_KEY, JSON.stringify(next));
      return next;
    });

  const forgetProject = (path: string) => {
    setRecentProjects((list) => list.filter((project) => project.path !== path));
    bridgeForKey(path)
      .forgetProject(path)
      .then(
        (list) => {
          // A computer's answer is its own list; this Mac's list stays, and the computer's scopes read it again.
          if (isRemoteKey(path)) window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
          else if (Array.isArray(list)) setRecentProjects(list);
        },
        () => {},
      );
  };

  // Checked in the project chooser; the flag lives with the Project, so the phone's list follows.
  const showProject = (path: string, show: boolean) => {
    if (path.startsWith("milagre-link:")) {
      const id = path.slice("milagre-link:".length);
      if (isRemoteKey(path)) {
        remote.setHidden(path, !show);
        const linkId = unqualifyKey(id);
        const bridge = bridgeForKey(path);
        void bridge.listNamedLinks().then((links) => {
          const link = links.find((l) => l.id === linkId);
          if (link) {
            bridge.updateNamedLink({ id: link.id, name: link.name, projectIds: link.projectIds, hidden: !show }).catch(() => {});
          }
        });
      } else {
        const link = namedLinks.find((l) => l.id === id);
        if (link) {
          setNamedLinks((links) => links.map((l) => (l.id === id ? { ...l, hidden: !show } : l)));
          window.milagre?.updateNamedLink?.({ id, name: link.name, projectIds: link.projectIds, hidden: !show }).catch(() => {
            setListsChanged((count) => count + 1);
          });
        }
      }
      return;
    }
    if (isRemoteKey(path)) remote.setHidden(path, !show);
    setRecentProjects((list) => list.map((project) => (project.path === path ? { ...project, hidden: !show } : project)));
    bridgeForKey(path)
      .setProjectHidden(path, !show)
      .then(
        (list) => {
          if (!isRemoteKey(path) && Array.isArray(list)) setRecentProjects(list);
          window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
        },
        () => setListsChanged((count) => count + 1),
      );
  };
  // By name, like the phone's: the recent list reorders as Projects open, and a row must not move under the pointer.
  // Other computers' Projects follow, each saying its computer; the open one of another computer is already a local row.
  const pickerProjects: PickerProject[] = [
    ...projects.map((row) => {
      const recent = recentProjects.find((project) => project.path === row.path);
      return { ...row, shown: !recent?.hidden, listed: !!recent, computer: multi && isRemoteKey(row.path) ? rowComputer(row.path)?.name : undefined };
    }),
    ...namedLinks.map((link) => ({
      path: `milagre-link:${link.id}`,
      name: link.name,
      initial: link.name.slice(0, 1).toUpperCase(),
      current: link.id === selectedLink?.id,
      shown: !link.hidden,
      listed: true,
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
        computer: rowComputer(project.path)?.name,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));

  // A Project's ⋯ rows: the four actions, and removing it from the list unless it's the open one. A Link gets its name copied and can be edited.
  const scopeMenu = (scope: { key: string; name: string; link: NamedProjectLink | null }, current: boolean): ScopeMenuItem[] => {
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
      ...(current
        ? []
        : [{ key: "remove", label: "Remove from list", icon: Cancel01Icon, destructive: true, separatorBefore: true, run: () => forgetProject(scope.key) }]),
    ];
  };

  const placeWorkspaceMenu = () => {
    const rect = workspaceButtonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    // Collapsed, the menu opens beside the rail instead of covering it.
    setWorkspacePosition(collapsed ? { top: rect.top, left: rect.right + 8 } : { top: rect.bottom + 6, left: rect.left });
    return true;
  };
  const openWorkspaceMenu = () => {
    if (placeWorkspaceMenu()) setWorkspaceOpen(true);
  };

  useDismiss(
    workspaceOpen,
    () => setWorkspaceOpen(false),
    (target) => !!target.closest("[data-workspace-trigger], [data-workspace-menu]"),
    placeWorkspaceMenu,
  );

  const collapse = () => {
    setCollapsed(true);
    setWorkspaceOpen(false);
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
        setWorkspaceOpen(false);
      } else if (autoCollapsed.current) {
        autoCollapsed.current = false;
        setCollapsed(false);
      }
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  // ⌘B / Ctrl+B toggles the sidebar exactly like its collapse button.
  useEffect(() => {
    function handleToggle(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", handleToggle);
    return () => window.removeEventListener("keydown", handleToggle);
  }, [collapsed]);

  const saveWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setExpandedWidth(next);
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  };

  const chrome = useWindowChrome();
  return (
    <div className={`relative flex min-h-0 shrink-0 flex-col ${fill ? "h-full" : "h-[600px]"} ${className}`}>
      <div
        data-sidebar-toggle
        className="absolute top-[calc(var(--window-chrome-top)-var(--window-chrome-height))] z-[60]"
        style={{ left: chrome.sidebarLeft - 12 }}
      >
        <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut="⌘B" side="bottom">
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
      <aside
        data-sidebar-collapsed={collapsed}
        aria-label="Workspace navigation"
        className="relative flex min-h-0 shrink-0 overflow-hidden rounded-window bg-surface shadow-card transition-[width]"
        style={
          {
            width: collapsed ? SIDEBAR_MOTION.collapsedWidth : expandedWidth,
            flex: "1 1 0%",
            // Following the pointer while dragging; the eased width transition would make the edge lag behind it.
            transitionDuration: resizing ? "0ms" : `${SIDEBAR_MOTION.duration}ms`,
            transitionTimingFunction: SIDEBAR_MOTION.easing,
            "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
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
          {!everyProject && !botsMode && (
            <div className="relative h-10 shrink-0">
              <button
                ref={workspaceButtonRef}
                data-workspace-trigger
                type="button"
                aria-expanded={workspaceOpen}
                aria-label={workspace.name}
                onClick={() => (workspaceOpen ? setWorkspaceOpen(false) : openWorkspaceMenu())}
                className="sidebar-workspace-control absolute left-2 top-1 flex h-8 w-[calc(100%-16px)] items-center rounded-[8px] px-2 text-left transition-[background-color,transform] duration-100 hover:bg-hover-2 active:scale-[0.99]"
              >
                <span className={`sidebar-logo relative flex ${selectedLink ? "h-5 w-9" : "size-5"} shrink-0 items-center justify-center text-ink`}>
                  {selectedLink ? (
                    <ProjectAvatarStack projects={selectedLink.projects} />
                  ) : (
                    <WorkspaceIcon src={workspace.image} fallback={<IconPopsicle2 size={18} />} />
                  )}
                  {/* Collapsed, the copy beside the logo hides, so the dot moves onto its corner. */}
                  {attentionPaths.length > 0 && (
                    <span
                      aria-hidden
                      className="absolute -top-0.5 -right-0.5 hidden size-2 rounded-full bg-orange ring-2 ring-surface in-data-[sidebar-collapsed=true]:block"
                    />
                  )}
                </span>
                <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">{workspace.name}</span>
                {selectedLink && <span className="sidebar-copy mr-1 text-[11px] text-ink-3">Link</span>}
                {attentionPaths.length > 0 && <AttentionDot className="sidebar-copy mr-1" />}
                <span className="sidebar-copy ml-1 flex shrink-0 text-ink-3">
                  <IconChevronDownSmall size={16} />
                </span>
              </button>

              {workspaceOpen && (
                <WorkspaceMenu
                  selectedLink={selectedLink}
                  links={namedLinks}
                  registeredProjects={registeredProjects}
                  onSwitchLink={onSwitchLink}
                  onLinkProject={onLinkProject}
                  onEditLink={onEditLink}
                  position={workspacePosition}
                  workspace={workspace}
                  projectPath={projectPath}
                  onOpenProjectSettings={onOpenProjectSettings}
                  projects={projects}
                  onSwitchProject={onSwitchProject}
                  onOpenProject={onOpenProject}
                  onForgetProject={forgetProject}
                  attentionPaths={attentionPaths}
                  onClose={() => setWorkspaceOpen(false)}
                />
              )}
            </div>
          )}
          <ScrollArea className={`sidebar-scroll flex-1 overflow-x-hidden ${everyProject && !botsOn ? "pt-2" : ""}`}>
            {botsMode ? (
              <BotList snapshot={bots.snapshot} selectedBotId={selectedBotId} onPickBot={(id) => onPickBot?.(id)} collapsed={collapsed} />
            ) : (
              <BotMarksContext.Provider value={botMarks}>
                {/* Canvas, Search and Filters in one row; collapsed, a column on the rail. */}
                <div
                  data-sidebar-tools
                  className={`mb-3 flex gap-1 ${collapsed ? "mx-auto w-8 flex-col items-center" : "mx-2 w-[calc(100%-16px)] items-center"}`}
                >
                  {onOpenCanvas && (
                    <Tooltip label="Canvas" side="bottom" className={collapsed ? "" : "min-w-0 flex-1"}>
                      <button
                        type="button"
                        aria-label="Canvas"
                        aria-pressed={canvasActive}
                        onClick={onOpenCanvas}
                        className={`${TOOL_BUTTON} ${collapsed ? "size-8" : "w-full"} ${canvasActive ? "bg-hover-2 text-ink" : ""}`}
                      >
                        <HugeIcon icon={GitMergeIcon} size={16} />
                        {!collapsed && <span className="sidebar-copy min-w-0 truncate">Canvas</span>}
                      </button>
                    </Tooltip>
                  )}
                  {onOpenCommands && (
                    <Tooltip
                      label="Search commands, chats, and projects"
                      side="bottom"
                      shortcut={`${shortcutModifier}K`}
                      className={collapsed ? "" : "min-w-0 flex-1"}
                    >
                      <button
                        type="button"
                        aria-label="Command palette"
                        aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
                        onClick={onOpenCommands}
                        className={`${TOOL_BUTTON} ${collapsed ? "size-8" : "w-full"}`}
                      >
                        <IconMagnifyingGlass size={16} />
                        {!collapsed && <span className="sidebar-copy min-w-0 truncate">Search</span>}
                      </button>
                    </Tooltip>
                  )}
                  <FiltersButton
                    projects={everyProject ? pickerProjects : null}
                    imageOf={scopeImage}
                    currentImage={selectedLink ? undefined : workspace.image}
                    onShowProject={showProject}
                    show={chatRowShow}
                    offerComputer={multi}
                    onShowField={(field, on) => updateSettings({ chatRowShow: { ...chatRowShow, [field]: on } })}
                    collapsed={collapsed}
                    className={`${TOOL_BUTTON} size-8 shrink-0`}
                  />
                </div>
                <SidebarLinksProvider scopes={linkScopes} projects={registeredProjects} onAskChat={onAskChat}>
                  {showAll ? (
                    <>
                      {/* Pinned chats of every Project and Link sit on top, like the single-project sidebar. Each group's list
                    renders its pinned rows into its slot here, so a drag moves a chat between Pinned and its group. */}
                      <div data-all-pinned={anyPinned || undefined} className={anyPinned ? "mb-2" : ""}>
                        {anyPinned && <p className="sidebar-copy mx-2 mb-1 h-8 pl-2 text-[12.5px] font-medium leading-8 text-ink-3">Pinned</p>}
                        {groups.map((group) => (
                          <div key={group.scope.key} ref={pinSlotRef(group.scope.key)} data-pinned-scope={group.scope.key} />
                        ))}
                      </div>
                      {groups.map(({ scope, current, state, rest, pinned, list, dimmed }, index) => {
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
                            {scope.link && !scopes[index - 1]?.link && (
                              <p className="mx-2 mt-1 mb-1 h-6 pl-2 text-[12.5px] font-medium leading-6 text-ink-3">Links</p>
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
                              onToggle={() => toggleScope(scope.key)}
                              onNewChat={
                                current
                                  ? () => {
                                      if (activeTitle === undefined) setDemoActiveTitle(null);
                                      onNewChat?.();
                                    }
                                  : () => onNewChatInScope?.(scope.key)
                              }
                              menu={scopeMenu(scope, current)}
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
                                    recents={pinned.length ? [...pinned, ...rest] : rest}
                                    scopeKey={scope.key}
                                    {...list}
                                    header={null}
                                    pinnedTarget={pinSlots[scope.key] ?? null}
                                    anyPinned={anyPinned}
                                  />
                                ) : !state && !current && failedScopes.has(scope.key) ? (
                                  <p className="mx-2 flex h-8 items-center gap-1 pl-9 text-[13px] text-ink-3">
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
                                  <p className="mx-2 h-8 pl-9 text-[13px] leading-8 text-ink-3">{state || current ? "No chats yet" : "Loading chats…"}</p>
                                )}
                              </div>
                            </div>
                          </section>
                        );
                      })}
                    </>
                  ) : railScopes ? (
                    <ScopeRail scopes={railScopes} onOpenScope={openRailScope} onOpenChat={openRailChat} />
                  ) : (
                    <ChatList
                      recents={recents}
                      scopeKey={currentKey}
                      isActive={(item) => (activeId !== undefined ? item.id === activeId : item.label === selectedTitle)}
                      collapsed={collapsed}
                      actions={chatActions}
                      showHints={showHints}
                      onPick={pickChat}
                      show={chatRowShow}
                      linkProjectId={selectedLink ? null : linkProjectIdOf(projectPath)}
                      header={
                        <div className={`sidebar-copy mx-2 mb-1 flex h-8 items-center justify-between pl-2 ${collapsed ? "hidden" : ""}`}>
                          <span className="text-[12.5px] font-medium text-ink-3">Chats</span>
                          <Tooltip label="New chat" shortcut="⌘N" align="end">
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

          {usage && <div className={`mt-3 border-t border-line pt-1.5 ${collapsed ? "mx-auto w-8" : "mx-2 w-[calc(100%-16px)]"}`}>{usage}</div>}

          <div
            className={`flex border-t border-line py-1.5 ${usage ? "mt-1.5" : "mt-3"} ${collapsed ? "mx-auto w-8 flex-col-reverse items-center gap-1" : "mx-2 w-[calc(100%-16px)] items-center justify-between"}`}
          >
            <div className={collapsed ? "flex flex-col-reverse items-center gap-1" : "flex items-center gap-1"}>
              <Tooltip label="Add project" shortcut="⌘O">
                <button
                  type="button"
                  aria-label="Add project"
                  onClick={() => onOpenProject?.()}
                  className={`${BOTTOM_BAR_BUTTON} ${collapsed ? "size-8" : "size-9"}`}
                >
                  <IconFolderAdd size={17} />
                </button>
              </Tooltip>
              {everyProject && onLinkProject && (
                <Tooltip label="Link projects">
                  <button
                    type="button"
                    aria-label="Link projects"
                    data-link-projects
                    onClick={onLinkProject}
                    className={`${BOTTOM_BAR_BUTTON} ${collapsed ? "size-8" : "size-9"}`}
                  >
                    <HugeIcon icon={Link04Icon} size={17} />
                  </button>
                </Tooltip>
              )}
              {onAddComputer && onOpenComputerSettings && (
                <ComputersButton
                  collapsed={collapsed}
                  buttonClassName={BOTTOM_BAR_BUTTON}
                  onAddComputer={onAddComputer}
                  onOpenSettings={onOpenComputerSettings}
                />
              )}
            </div>
            <Tooltip label="Settings" shortcut="⌘," align={collapsed ? "start" : "end"}>
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

function ChatList({
  recents,
  scopeKey,
  isActive,
  collapsed,
  actions,
  showHints,
  onPick,
  linkProjectId,
  computer,
  show,
  dimOffline,
  header,
  pinnedHeader = true,
  hintOffset = 0,
  pinnedTarget,
  anyPinned = false,
}: {
  recents: SidebarRecent[];
  /** The Project path or Link key the chats belong to. */
  scopeKey: string;
  isActive: (item: SidebarRecent) => boolean;
  collapsed: boolean;
  actions: ChatRowActions;
  showHints: boolean;
  onPick: (item: SidebarRecent) => void;
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
}) {
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
  const rest = recents.filter((item) => !item.pinned);
  const byId = (id: string | null) => recents.find((item) => item.id === id);
  const otherList = (scope: string | undefined) => (scope === undefined ? undefined : sidebarLinks.lists().find((handle) => handle.scopeKey === scope));

  // Window listeners and memoized row actions call through this, so they always see the latest render.
  const live = useRef({ recents, actions, over, drop, finish, hit, sidebarLinks });
  live.current = { recents, actions, over, drop, finish, hit, sidebarLinks };

  // Another Project's list finds this one's rows when a drag from there ends here.
  useEffect(() => {
    if (!linkProjectId) return;
    const handle: LinkListHandle = { scopeKey, containers, byId: (id) => live.current.recents.find((item) => item.id === id) };
    return sidebarLinks.register(handle);
  }, [scopeKey, linkProjectId]);

  const showToast = (text: string, undo?: () => void) => {
    const aside = listRef.current?.closest("aside")?.getBoundingClientRect();
    live.current.sidebarLinks.toast(text, { undo, left: (aside?.right ?? 0) + 12 });
  };

  /** Beside the sidebar, level with the row the menu or the drop was on. */
  const anchorAt = (top: number) => {
    const aside = listRef.current?.closest("aside")?.getBoundingClientRect();
    return { top: Math.max(8, top), left: (aside?.right ?? 0) + 8 };
  };

  // Pinning from the row menu and from a drag both land here, so either can be undone. The Link items open the
  // shared "Link with…" and "Remove Link with…" lists.
  const rowActions = useMemo<ChatRowActions>(
    () => ({
      ...actions,
      onPin:
        actions.onPin &&
        ((id, order) => {
          const now = live.current;
          const item = now.recents.find((row) => row.id === id);
          if (!item || !now.actions.onPin) return;
          const orders = now.recents.filter((row) => row.pinned && row.id !== id).map((row) => row.pinOrder ?? 0);
          const next = order === undefined ? pinOrderAt(orders, orders.length) : order;
          const previous = item.pinned ? (item.pinOrder ?? 0) : null;
          now.actions.onPin(id, next);
          if ((previous === null) !== (next === null)) showToast(next === null ? "Unpinned" : "Pinned", () => live.current.actions.onPin?.(id, previous));
        }),
      ...(linkProjectId
        ? {
            onLinkWith: (id: string, anchor: { top: number; left: number }) => {
              const item = live.current.recents.find((row) => row.id === id);
              if (item) live.current.sidebarLinks.pick({ scopeKey, item }, anchor, "link");
            },
            onRemoveLink: (id: string, anchor: { top: number; left: number }) => {
              const item = live.current.recents.find((row) => row.id === id);
              if (item) live.current.sidebarLinks.pick({ scopeKey, item }, anchor, "remove");
            },
          }
        : {}),
    }),
    [actions, linkProjectId, scopeKey],
  );

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
    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
        started = true;
        begin(id, false);
      }
      live.current.over(live.current.hit(moveEvent.clientX, moveEvent.clientY));
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
      live.current.drop();
    };
    const cancel = () => {
      stop();
      if (started) live.current.finish();
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
      live.current.finish();
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
      over(all[index === -1 ? (step > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, index + step))]);
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
  const row = (item: SidebarRecent, index: number) => (
    <ChatRow
      key={item.id}
      item={item}
      active={isActive(item)}
      collapsed={collapsed}
      actions={rowActions}
      shortcutHint={showHints && hintOffset + index < 9 ? `${shortcutModifier}${hintOffset + index + 1}` : undefined}
      onPick={onPick}
      computer={computer}
      show={show}
      dimOffline={dimOffline || (Boolean(pinnedTarget) && Boolean(item.pinned))}
      dragging={drag?.id === item.id}
      linked={linkProjectId ? sidebarLinks.endsFor(scopeKey, item) : undefined}
      bot={botMarks.get(`${scopeKey}#${item.id}`)}
    />
  );

  const target = (invalid: boolean, hint: string | null) => (
    <>
      {invalid && hint ? (
        <span className="absolute left-0 top-full z-40 mt-1 rounded-[6px] bg-surface px-2 py-1 text-[11.5px] text-red shadow-overlay">{hint}</span>
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
          {pinned.map(row)}
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
              <div className="flex flex-col gap-px">{pinned.map(row)}</div>
            </div>
          )}
        </>
      )}
      {collapsed && pinned.length > 0 && <div className="mx-auto mb-2 h-px w-5 bg-line" />}
      {header}
      <div className="flex flex-col gap-px">{rest.map((item, index) => row(item, pinned.length + index))}</div>

      {indicator(false)}
      {foreignIndicator}

      <div aria-live="assertive" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
