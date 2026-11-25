import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import {
  ArrowDown01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  CornerDownRightIcon,
  Layers01Icon,
  LayoutTwoColumnIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import {
  chatOf,
  closeOtherTabs,
  closeTab,
  MAIN_CHAT_CLOSE_TITLE,
  mainChatCloseMessage,
  newChatTabLabel,
  type TabPlace,
  mainChatId,
  moveTab,
  openTab,
  selectTab,
  setBeside,
  tabId,
  tabShortcutDigit,
  type OpenTab,
  type WorkspaceTab,
} from "@milagre/shared/workspace-tabs";
import { closeBrowserTab } from "../../lib/browser-panel";
import { pageIcon, pageLabel, useWorkspaceTabSources, type TabPanels, type TabSession } from "./use-workspace-tab-sources";
import { setBookmarkReserve } from "../../lib/bookmark-reserve";
import { useWindowChrome } from "../../lib/window-chrome";
import { tabSet, updateTabSet, useTabSet } from "../../lib/workspace-tabs-store";
import { Button, IconButton } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Icon } from "../primitives/Icon";
import { MenuRow, Popover } from "../primitives/Popover";
import { ChatHoverCard } from "../sidebar/ChatHoverCard";
import { ChatMarkDotInline } from "../sidebar/ChatMarks";
import type { SidebarRecent } from "../sidebar/ChatRow";
import { HOVER_CARD_WIDTH } from "../sidebar/chat-row-parts";

const HOVER_DELAY = 500;
const HOVER_GRACE = 250;
const DRAG_SLOP = 5;
const DRAFT = "draft";

export type TabMenuEntry = { key: string; title: string; icon: IconSvgElement; shortcut?: string; tab?: WorkspaceTab; onSelect: () => void };

type Props = {
  workspace: string;
  projectPath: string;
  panels: TabPanels;
  sessions: Record<string, TabSession> | undefined;
  belongs: (session: TabSession) => boolean;
  rows: readonly SidebarRecent[];
  activeChatId: number | null;
  corner: number;
  menu: readonly TabMenuEntry[];
  onOpenChat: (chatId: number) => void;
  onNewChat: () => void;
};

/**
 * The Worktree's Workspace tabs in the top bar, where ChatIdentity sits when the setting is off. Each Chat and Subchat
 * of the Worktree the user opened is a tab; drafting a new Chat shows a New Chat tab at the end until it is sent.
 */
export function WorkspaceTabStrip({ workspace, projectPath, panels, sessions, belongs, rows, activeChatId, corner, menu, onOpenChat, onNewChat }: Props) {
  const set = useTabSet(workspace);
  const chrome = useWindowChrome();
  const anchor = useRef<HTMLSpanElement>(null);
  const [columnLeft, setColumnLeft] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [dragging, setDragging] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<{ id: string; x: number; y: number } | null>(null);
  const [popover, setPopover] = useState<"add" | "all" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const hover = useHoverCard();
  const drafting = activeChatId === null;
  const place: TabPlace = isLinkScopeKey(projectPath) ? "link" : "worktree";
  const rowOf = (chatId: number) => rows.find((row) => row.id === String(chatId));
  const parentOf = (chatId: number) => sessions?.[chatId]?.parent;

  const measure = () => {
    const element = scroller.current;
    if (!element) return;
    const left = element.scrollLeft > 2;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
    setEdges((current) => (current.left === left && current.right === right ? current : { left, right }));
  };
  useLayoutEffect(measure, [set, drafting]);
  useLayoutEffect(() => {
    const host = anchor.current?.offsetParent;
    const box = group.current;
    if (!(host instanceof HTMLElement) || !box) return;
    const update = () => {
      measure();
      const column = host.getBoundingClientRect().left;
      setColumnLeft(column + 12);
      setBookmarkReserve(box.getBoundingClientRect().right - column + 8);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    observer.observe(host);
    return () => {
      observer.disconnect();
      setBookmarkReserve(0);
    };
  }, []);

  const shownActive = drafting ? DRAFT : set.active;
  useEffect(() => {
    scroller.current?.querySelector(`[data-workspace-tab="${shownActive}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [shownActive]);

  const focus = (tab: OpenTab) => {
    updateTabSet(workspace, (current) => selectTab(current, tabId(tab)));
    const owner = chatOf(tab);
    if (owner !== undefined && owner !== activeChatId) onOpenChat(owner);
  };
  useWorkspaceTabSources({ workspace, projectPath, sessions, belongs, set, activeChatId, panels, onOpenChat, onFocus: focus });
  const close = (id: string) => {
    hover.hide();
    if (id === DRAFT) {
      const back = set.tabs.find((tab) => tabId(tab) === set.active) ?? set.tabs.at(-1);
      if (back) focus(back);
      return;
    }
    const before = tabSet(workspace);
    const closing = before.tabs.find((tab) => tabId(tab) === id);
    if (closing?.kind === "browser") closeBrowserTab(`${projectPath}#${closing.chatId}`, closing.pageId);
    const after = closeTab(before, id);
    updateTabSet(workspace, () => after);
    if (drafting || id !== before.active) return;
    const next = after.tabs.find((tab) => tabId(tab) === after.active);
    if (next) focus(next);
    else onNewChat();
  };

  const main = mainChatId(Object.values(sessions ?? {}).filter(belongs));
  const requestClose = (id: string) => {
    hover.hide();
    if (main !== undefined && id === `chat:${main}`) setConfirming(id);
    else close(id);
  };

  const startDrag = useTabDrag(workspace, scroller, setDragging, hover.hide);

  const label = (tab: OpenTab) => (tab.kind === "chat" ? (rowOf(tab.chatId)?.label ?? "Chat") : pageLabel(projectPath, tab));
  const mask = `linear-gradient(to right, ${edges.left ? "transparent 0, #000 28px" : "#000 0"}, ${edges.right ? "#000 calc(100% - 28px), transparent 100%" : "#000 100%"})`;
  const menuTab = menuAt ? set.tabs.find((tab) => tabId(tab) === menuAt.id) : undefined;
  const menuParent = menuTab?.kind === "chat" ? parentOf(menuTab.chatId) : undefined;

  return (
    <>
      <span ref={anchor} aria-hidden className="absolute" />
      {createPortal(
        <div
          data-workspace-tabs
          style={{ left: Math.max(chrome.controlsEnd, columnLeft), right: chrome.rightInset + 12 + (corner ? corner + 20 : 0) }}
          className="pointer-events-none fixed top-[var(--window-chrome-top)] z-[55] flex h-8 select-none items-center"
        >
          <div ref={group} className="no-drag pointer-events-auto flex min-w-0 max-w-full items-center gap-0.5">
            <div
              ref={scroller}
              role="tablist"
              aria-label="Workspace tabs"
              onScroll={measure}
              onWheel={(event) => {
                if (scroller.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) scroller.current.scrollLeft += event.deltaY;
              }}
              className="no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
              style={{ maskImage: mask, WebkitMaskImage: mask }}
            >
              {set.tabs.map((tab) => {
                const id = tabId(tab);
                const row = tab.kind === "chat" ? rowOf(tab.chatId) : undefined;
                return (
                  <Tab
                    key={id}
                    id={id}
                    title={label(tab)}
                    active={!drafting && set.active === id}
                    dragging={dragging === id}
                    unread={Boolean(tab.unread || row?.unread)}
                    subchat={tab.kind === "chat" && parentOf(tab.chatId) !== undefined}
                    icon={pageIcon(tab)}
                    beside={Boolean(tab.beside)}
                    mark={
                      row?.mark && row.mark !== "idle" && row.mark !== "unread" ? (
                        <ChatMarkDotInline mark={row.mark} failed={false} background={row.background} />
                      ) : null
                    }
                    shortcut={tabShortcutDigit(set, id)}
                    onSelect={() => focus(tab)}
                    onClose={() => requestClose(id)}
                    onDragStart={(event) => startDrag(id, event)}
                    onMenu={(x, y) => setMenuAt({ id, x, y })}
                    onHover={(element) => row && hover.show(row, element)}
                    onLeave={hover.hideSoon}
                  />
                );
              })}
              {drafting && (
                <Tab
                  id={DRAFT}
                  title="New Chat"
                  active
                  dragging={false}
                  unread={false}
                  subchat={false}
                  mark={null}
                  onSelect={() => undefined}
                  onClose={() => close(DRAFT)}
                  onDragStart={() => undefined}
                  onMenu={() => undefined}
                  onHover={() => undefined}
                  onLeave={() => undefined}
                />
              )}
            </div>
            <IconButton
              ref={addButton}
              size={24}
              label="New tab"
              icon={PlusSignIcon}
              side="bottom"
              data-workspace-tab-add
              onClick={() => setPopover(popover === "add" ? null : "add")}
            />
            {(edges.left || edges.right) && (
              <IconButton
                ref={allButton}
                size={24}
                label={`All tabs (${set.tabs.length})`}
                icon={ArrowDown01Icon}
                side="bottom"
                onClick={() => setPopover(popover === "all" ? null : "all")}
              />
            )}
          </div>
          {popover === "add" && (
            <AddTabMenu
              anchor={addButton}
              menu={menu.map(({ tab, ...entry }) => (tab ? { ...entry, onSelect: () => updateTabSet(workspace, (current) => openTab(current, tab)) } : entry))}
              newChat={{ label: newChatTabLabel(place), onSelect: onNewChat }}
              onClose={() => setPopover(null)}
            />
          )}
          {popover === "all" && (
            <AllTabsMenu
              anchor={allButton}
              tabs={set.tabs}
              active={drafting ? null : set.active}
              label={label}
              subchat={(tab) => tab.kind === "chat" && parentOf(tab.chatId) !== undefined}
              onPick={focus}
              onClose={() => setPopover(null)}
            />
          )}
          {menuAt && menuTab && (
            <TabMenu
              at={menuAt}
              parent={menuParent}
              beside={menuTab.kind === "browser" || menuTab.kind === "designs" || menuTab.kind === "terminal" ? Boolean(menuTab.beside) : undefined}
              onBeside={() => {
                updateTabSet(workspace, (current) => setBeside(current, menuAt.id, !menuTab.beside));
                focus(menuTab);
              }}
              onClose={() => setMenuAt(null)}
              onParent={onOpenChat}
              onCloseTab={() => requestClose(menuAt.id)}
              onCloseOthers={() => {
                updateTabSet(workspace, (current) => closeOtherTabs(current, menuAt.id));
                focus(menuTab);
              }}
            />
          )}
          {confirming && (
            <CloseMainChatDialog
              title={main === undefined ? "Chat" : (rowOf(main)?.label ?? "Chat")}
              place={place}
              onCancel={() => setConfirming(null)}
              onConfirm={() => {
                setConfirming(null);
                close(confirming);
              }}
            />
          )}
          {hover.card &&
            createPortal(
              <ChatHoverCard
                item={hover.card.row}
                linked={[]}
                position={hover.card.position}
                onPointerEnter={hover.keep}
                onPointerLeave={hover.hideSoon}
                onOpenLink={hover.hide}
              />,
              document.body,
            )}
        </div>,
        document.body,
      )}
    </>
  );
}

function AddTabMenu({
  anchor,
  menu,
  newChat,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  menu: readonly TabMenuEntry[];
  newChat: { label: string; onSelect: () => void };
  onClose: () => void;
}) {
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Popover anchor={anchor} align="start" width={260} label="New tab" onClose={onClose} data-workspace-tab-menu>
      <MenuRow icon={BubbleChatIcon} title={newChat.label} onClick={pick(newChat.onSelect)} />
      {menu.map((entry) => (
        <MenuRow
          key={entry.key}
          icon={entry.icon}
          title={entry.title}
          trailing={entry.shortcut && <span className="text-12 text-ink-3">{entry.shortcut}</span>}
          onClick={pick(entry.onSelect)}
        />
      ))}
    </Popover>
  );
}

function AllTabsMenu({
  anchor,
  tabs,
  active,
  label,
  subchat,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  tabs: readonly OpenTab[];
  active: string | null;
  label: (tab: OpenTab) => string;
  subchat: (tab: OpenTab) => boolean;
  onPick: (tab: OpenTab) => void;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} align="start" width={300} label="All tabs" onClose={onClose}>
      {tabs.map((tab) => (
        <MenuRow
          key={tabId(tab)}
          icon={subchat(tab) ? CornerDownRightIcon : (pageIcon(tab) ?? BubbleChatIcon)}
          title={<span className="truncate">{label(tab)}</span>}
          checked={active === tabId(tab)}
          onClick={() => {
            onClose();
            onPick(tab);
          }}
        />
      ))}
    </Popover>
  );
}

function CloseMainChatDialog({ title, place, onCancel, onConfirm }: { title: string; place: TabPlace; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      role="alertdialog"
      title={MAIN_CHAT_CLOSE_TITLE}
      description={mainChatCloseMessage(title, place)}
      onClose={onCancel}
      data-main-chat-close
      actions={
        <>
          <Button variant="ghost" autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Close tab
          </Button>
        </>
      }
    />
  );
}

function TabMenu({
  at,
  parent,
  beside,
  onBeside,
  onClose,
  onParent,
  onCloseTab,
  onCloseOthers,
}: {
  at: { x: number; y: number };
  parent: number | undefined;
  beside: boolean | undefined;
  onBeside: () => void;
  onClose: () => void;
  onParent: (chatId: number) => void;
  onCloseTab: () => void;
  onCloseOthers: () => void;
}) {
  const pick = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Popover anchor={{ x: at.x, y: at.y }} align="start" width={220} label="Tab" onClose={onClose}>
      {parent !== undefined && <MenuRow icon={CornerDownRightIcon} title="Go to parent Chat" onClick={pick(() => onParent(parent))} />}
      {beside !== undefined && <MenuRow icon={LayoutTwoColumnIcon} title={beside ? "Show on its own" : "Show beside the Chat"} onClick={pick(onBeside)} />}
      <MenuRow icon={Cancel01Icon} title="Close tab" onClick={pick(onCloseTab)} />
      <MenuRow icon={Layers01Icon} title="Close other tabs" onClick={pick(onCloseOthers)} />
    </Popover>
  );
}

function Tab({
  id,
  title,
  active,
  dragging,
  unread,
  subchat,
  icon,
  beside,
  mark,
  shortcut,
  onSelect,
  onClose,
  onDragStart,
  onMenu,
  onHover,
  onLeave,
}: {
  id: string;
  title: string;
  active: boolean;
  dragging: boolean;
  unread: boolean;
  subchat: boolean;
  icon?: IconSvgElement;
  beside?: boolean;
  mark: ReactNode;
  shortcut?: number;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: (event: React.PointerEvent) => void;
  onMenu: (x: number, y: number) => void;
  onHover: (element: HTMLElement) => void;
  onLeave: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-workspace-tab={id}
      data-active={active || undefined}
      title={shortcut ? `⌘${shortcut}` : undefined}
      onPointerEnter={(event) => onHover(event.currentTarget)}
      onPointerLeave={onLeave}
      onPointerDown={(event) => {
        onLeave();
        if (event.button === 1) {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.button !== 0) return;
        onSelect();
        onDragStart(event);
      }}
      onAuxClick={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      className={`group flex h-7 max-w-[200px] shrink-0 items-center gap-1.5 rounded-control pr-1 pl-2.5 text-12 font-medium transition-colors ${
        dragging ? "z-10 bg-hover-2 text-ink shadow-raised" : active ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2"
      }`}
    >
      {subchat && <Icon icon={CornerDownRightIcon} size={12} className="shrink-0 text-ink-4" />}
      <span className="flex size-3.5 shrink-0 items-center justify-center">{mark ?? <Icon icon={icon ?? BubbleChatIcon} size={14} />}</span>
      <span className="min-w-0 truncate">{title}</span>
      {unread && !active && <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-accent" />}
      {beside && <Icon icon={LayoutTwoColumnIcon} size={12} className="shrink-0 text-ink-3" />}
      <button
        type="button"
        aria-label={`Close ${title}`}
        tabIndex={-1}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.button === 0) onClose();
        }}
        className={`flex size-[18px] shrink-0 items-center justify-center rounded-inline text-ink-3 hover:bg-hover-2 hover:text-ink ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
      >
        <Icon icon={Cancel01Icon} size={12} />
      </button>
    </div>
  );
}

function useTabDrag(workspace: string, scroller: React.RefObject<HTMLDivElement | null>, setDragging: (id: string | null) => void, onStart: () => void) {
  return (id: string, event: React.PointerEvent) => {
    if (id === DRAFT) return;
    const startX = event.clientX;
    let moving = false;
    const move = (next: PointerEvent) => {
      if (!moving && Math.abs(next.clientX - startX) < DRAG_SLOP) return;
      const element = scroller.current;
      if (!element) return;
      if (!moving) {
        moving = true;
        setDragging(id);
        onStart();
      }
      const box = element.getBoundingClientRect();
      if (next.clientX < box.left + 32) element.scrollLeft -= 10;
      else if (next.clientX > box.right - 32) element.scrollLeft += 10;
      const centers = [...element.querySelectorAll<HTMLElement>("[data-workspace-tab]")]
        .filter((tab) => tab.dataset.workspaceTab !== id && tab.dataset.workspaceTab !== DRAFT)
        .map((tab) => {
          const rect = tab.getBoundingClientRect();
          return rect.left + rect.width / 2;
        });
      updateTabSet(workspace, (current) => moveTab(current, id, centers.filter((center) => center < next.clientX).length));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

function useHoverCard() {
  const timer = useRef<number | null>(null);
  const [card, setCard] = useState<{ row: SidebarRecent; position: { top: number; left: number; flip: boolean } } | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return {
    card,
    keep: clear,
    hide: () => {
      clear();
      setCard(null);
    },
    hideSoon: () => {
      clear();
      timer.current = window.setTimeout(() => setCard(null), HOVER_GRACE);
    },
    show: (row: SidebarRecent, element: HTMLElement) => {
      clear();
      if (document.documentElement.hasAttribute("data-chat-drag")) return;
      timer.current = window.setTimeout(() => {
        const rect = element.getBoundingClientRect();
        setCard({ row, position: { top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - HOVER_CARD_WIDTH - 12), flip: false } });
      }, HOVER_DELAY);
    },
  };
}
