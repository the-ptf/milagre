import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link04Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../primitives/Icon";
import { SectionLabel } from "../primitives/SectionLabel";
import type { ChatRowShow } from "@milagre/shared/chat-row";
import { useEvent } from "../../lib/stable";
import { ChatRow, type ChatRowActions, type RowComputer, type SidebarRecent } from "./ChatRow";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { gridDrop, type GridDropTarget } from "@/lib/grid-drop";
import { useSidebarLinks } from "./SidebarLinks";
import { useSettings } from "../../lib/settings";
import { type FlatChat } from "../../lib/sidebar-scopes";
import {
  activeFamilyRoot,
  useUnfoldActiveFamily,
  jumpChatRows,
  rowKeys,
  shownChats,
  standInRow,
  useSubchatFolds,
  type ShownRow,
  type SubchatFolds,
} from "../../lib/subchat-rows";
import { useSidebarKeys } from "./use-sidebar-keys";
import { useChatListDrag } from "./use-chat-list-drag";
import { DRAG_THRESHOLD, DROP_HINTS } from "./scope-drag";
import { type RowActionsNow, chatRowActions } from "./chat-row-actions";

const ALL_FOLDED: SubchatFolds = { has: () => true };

const subchatAsks = (row: Pick<SidebarRecent, "mark">) => row.mark === "question" || row.mark === "waiting";

export type ScopeBadge = { projectImage: string | null; projectInitial: string; linkProjects?: number; projectChats?: boolean };

export type FlatScope = {
  name: string;
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
  rows: SidebarRecent[];
};

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

export const NO_BADGE: ScopeBadge = { projectImage: null, projectInitial: "" };

export const CHATS_BADGE: ScopeBadge = { projectImage: null, projectInitial: "", projectChats: true };

export function FlatChatList({
  chats,
  scopes,
  inbox = true,
}: {
  chats: (FlatChat & { offline?: boolean })[];
  scopes: Map<string, FlatScope>;
  inbox?: boolean;
}) {
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
  const readScope = useEvent((scopeKey: string): RowActionsNow => {
    const scope = scopes.get(scopeKey);
    return { recents: scope?.rows ?? [], actions: scope?.list.actions ?? {}, sidebarLinks };
  });
  const nowOf = (scopeKey: string) => () => readScope(scopeKey);
  const [made] = useState(() => new Map<string, { source: ChatRowActions; linkProjectId: string | null; actions: ChatRowActions }>());
  const actionsOf = (scopeKey: string, scope: FlatScope) => {
    const hit = made.get(scopeKey);
    if (hit && hit.source === scope.list.actions && hit.linkProjectId === scope.list.linkProjectId) return hit.actions;
    const actions = chatRowActions(scope.list.actions, scope.list.linkProjectId, scopeKey, nowOf(scopeKey));
    made.set(scopeKey, { source: scope.list.actions, linkProjectId: scope.list.linkProjectId, actions });
    return actions;
  };
  const handFolds = useSubchatFolds();
  const rowStyle = useSettings().appearance.sidebarRows;
  const titleFirst = inbox && rowStyle === "edge";
  const folds = titleFirst ? ALL_FOLDED : handFolds;
  const hintPositions = useMemo(() => {
    const positions = new Map<SidebarRecent, number>();
    for (const [key, { list, rows }] of scopes)
      if (list.showHints)
        jumpChatRows(rows, key, folds)
          .slice(0, 9)
          .forEach((row, at) => positions.set(row, at));
    return positions;
  }, [scopes, folds]);
  const shownFlat = useMemo(() => {
    const free = chats.filter((chat) => !chat.row.pinned);
    const nested = shownChats(free, {
      key: (chat) => `${chat.scopeKey}#${chat.row.id}`,
      parent: (chat) => (chat.row.parent === undefined ? undefined : `${chat.scopeKey}#${chat.row.parent}`),
      folded: folds,
      asking: (chat) => subchatAsks(chat.row),
    });
    if (free.length === chats.length) return nested;
    const pinned: (ShownRow & { item: (typeof chats)[number] })[] = chats.filter((chat) => chat.row.pinned).map((item) => ({ item, subchat: false, depth: 0 }));
    return [...pinned, ...nested];
  }, [chats, folds]);
  const flatKeys = {
    key: (chat: (typeof chats)[number]) => `${chat.scopeKey}#${chat.row.id}`,
    parent: (chat: (typeof chats)[number]) => (chat.row.parent === undefined ? undefined : `${chat.scopeKey}#${chat.row.parent}`),
  };
  const isFlatActive = (chat: (typeof chats)[number]) => scopes.get(chat.scopeKey)?.list.isActive(chat.row) ?? false;
  const activeFlat = chats.find(isFlatActive);
  const standIn = standInRow(shownFlat, chats, flatKeys, isFlatActive);
  useUnfoldActiveFamily(activeFamilyRoot(chats, flatKeys, isFlatActive), activeFlat && flatKeys.key(activeFlat));
  return (
    <div ref={listRef} data-chat-list-flat className="flex flex-col gap-px" onPointerDown={startDrag}>
      {shownFlat.map(({ item: { scopeKey, row, offline }, subchat, depth, family }) => {
        const scope = scopes.get(scopeKey)!;
        const { list } = scope;
        const position = list.showHints ? (hintPositions.get(row) ?? -1) : -1;
        const key = `${scopeKey}#${row.id}`;
        return (
          <div key={key} data-chat-key={key} data-offline={offline || undefined} className="contents">
            <ChatRow
              item={row}
              active={list.isActive(row) || key === standIn}
              collapsed={false}
              actions={actionsOf(scopeKey, scope)}
              shortcutHint={position >= 0 && position < 9 ? keys.jump(position) : undefined}
              onPick={list.onPick}
              onHover={list.onHover}
              computer={list.computer}
              show={list.show}
              dimOffline
              linked={list.linkProjectId ? sidebarLinks.endsFor(scopeKey, row) : undefined}
              chatKey={key}
              subchat={subchat}
              depth={depth}
              family={titleFirst ? undefined : family}
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

export function ChatList({
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
  scopeKey: string;
  isActive: (item: SidebarRecent) => boolean;
  collapsed: boolean;
  actions: ChatRowActions;
  showHints: boolean;
  onPick: (item: SidebarRecent) => void;
  onHover?: (item: SidebarRecent) => void;
  linkProjectId: string | null;
  computer?: RowComputer;
  show: ChatRowShow;
  dimOffline?: boolean;
  header: ReactNode;
  pinnedHeader?: boolean;
  hintOffset?: number;
  pinnedTarget?: HTMLElement | null;
  anyPinned?: boolean;
  projectName?: string;
  projectImage?: string | null;
  projectInitial?: string;
  linkProjects?: number;
}) {
  const keys = useSidebarKeys();
  const sidebarLinks = useSidebarLinks();
  const { listRef, pinRef, drag, mark, foreignMark, announcement, rowActions, intent, startPointer, keyDown, keyUp } = useChatListDrag({
    recents,
    scopeKey,
    linkProjectId,
    actions,
    collapsed,
    sidebarLinks,
  });
  const pinned = recents.filter((item) => item.pinned);
  const rest = useMemo(() => recents.filter((item) => !item.pinned), [recents]);
  const folds = useSubchatFolds();
  const shownRest = useMemo(
    () =>
      collapsed ? rest.map((item) => ({ item, subchat: false, depth: 0 })) : shownChats(rest, { ...rowKeys(scopeKey), folded: folds, asking: subchatAsks }),
    [rest, folds, collapsed, scopeKey],
  );
  const activeRow = rest.find(isActive);
  useUnfoldActiveFamily(collapsed ? undefined : activeFamilyRoot(rest, rowKeys(scopeKey), isActive), activeRow && `${scopeKey}#${activeRow.id}`);
  const standIn = collapsed ? undefined : standInRow(shownRest, rest, rowKeys(scopeKey), isActive);
  const row = (item: SidebarRecent, index: number, shown?: ShownRow) => (
    <ChatRow
      key={item.id}
      item={item}
      subchat={shown?.subchat}
      depth={shown?.depth}
      family={shown?.family}
      onPick={onPick}
      active={isActive(item) || `${scopeKey}#${item.id}` === standIn}
      collapsed={collapsed}
      actions={rowActions}
      shortcutHint={showHints && hintOffset + index < 9 ? keys.jump(hintOffset + index) : undefined}
      onHover={onHover}
      computer={pinnedTarget !== undefined && !item.pinned ? undefined : computer}
      show={show}
      dimOffline={dimOffline || (Boolean(pinnedTarget) && Boolean(item.pinned))}
      dragging={drag?.id === item.id}
      linked={linkProjectId ? sidebarLinks.endsFor(scopeKey, item) : undefined}
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
        <span className="absolute left-0 top-full z-40 mt-1 rounded-chip bg-surface px-2 py-1 text-11 text-red-ink shadow-raised">{hint}</span>
      ) : (
        <Icon icon={Link04Icon} size={14} />
      )}
    </>
  );
  const targetClass = (invalid: boolean) =>
    `pointer-events-none z-30 flex items-center justify-end rounded-control pr-2 ring-2 ${invalid ? "bg-red-tint ring-red" : "bg-accent-tint text-accent-ink ring-accent"}`;
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
  const pinnedRows = pinnedTarget ? (
    <div ref={pinRef} data-chat-list-pins data-chat-scope={scopeKey} className="relative">
      {drag && pinned.length === 0 && !anyPinned && !collapsed && (
        <div className="sidebar-copy mx-2 mb-1 flex h-8 items-center pl-2">
          <SectionLabel as="span">Pinned</SectionLabel>
        </div>
      )}
      {drag && pinned.length === 0 && !collapsed && (
        <div
          data-pin-zone
          className={`mx-2 mb-1 flex h-8 items-center justify-center rounded-control border border-dashed text-12 ${drag.target?.id === null ? "border-accent bg-accent-tint text-accent-ink" : "border-line-strong text-ink-3"}`}
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
      {pinnedTarget ? (
        createPortal(pinnedRows, pinnedTarget)
      ) : (
        <>
          {pinnedHeader && (pinned.length > 0 || drag) && !collapsed && (
            <div className="sidebar-copy mx-2 mb-1 flex h-8 items-center pl-2">
              <SectionLabel as="span">Pinned</SectionLabel>
            </div>
          )}
          {drag && pinned.length === 0 && !collapsed && (
            <div
              data-pin-zone
              className={`mx-2 mb-1 flex h-8 items-center justify-center rounded-control border border-dashed text-12 ${drag.target?.id === null ? "border-accent bg-accent-tint text-accent-ink" : "border-line-strong text-ink-3"}`}
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
