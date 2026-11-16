import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import { gridDrop, type GridDropTarget } from "@/lib/grid-drop";
import { dropIntent, pinOrderAt, type DropIntent, type DropZone } from "@/lib/chat-list";
import { linkBetween } from "@milagre/shared/chat-links";
import type { useSidebarLinks, LinkListHandle } from "./SidebarLinks";
import type { ChatRowActions, SidebarRecent } from "./ChatRow";
import { DRAG_THRESHOLD, DROP_HINTS, type DropTarget, type ChatDrag, sameTarget } from "./scope-drag";
import { chatRowActions } from "./chat-row-actions";
import { useEvent } from "../../lib/stable";

type DropModelContext = {
  recents: SidebarRecent[];
  linkProjectId: string | null;
  links: ReturnType<typeof useSidebarLinks>["links"];
  sidebarLinks: ReturnType<typeof useSidebarLinks>;
  byId: (id: string | null) => SidebarRecent | undefined;
  otherList: (scope: string | undefined) => LinkListHandle | undefined;
};

function dropModel({ recents, linkProjectId, links, sidebarLinks, byId, otherList }: DropModelContext) {
  const endpoint = (item: SidebarRecent) => ({ pinned: item.pinned, worktree: item.details?.path });
  const linkedTo = (a: SidebarRecent, b: SidebarRecent, bProject: string | null) =>
    !!linkProjectId &&
    !!bProject &&
    !!a.details?.path &&
    !!b.details?.path &&
    !!linkBetween(links, { project_id: linkProjectId, worktree_path: a.details.path }, { project_id: bProject, worktree_path: b.details.path });

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
    const sameProject = target.scope === undefined;
    return dropIntent(
      endpoint(source),
      onto && (sameProject ? endpoint(onto) : { pinned: onto.pinned }),
      target.zone,
      Boolean(onto && linkedTo(source, onto, projectId)),
    );
  }

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
  return { targetChat, intentOf, pinSlot, describe };
}

type HitContext = {
  scopeKey: string;
  linkProjectId: string | null;
  sidebarLinks: ReturnType<typeof useSidebarLinks>;
  containers: () => HTMLDivElement[];
  dragRef: RefObject<ChatDrag | null>;
};

function hitTest({ scopeKey, linkProjectId, sidebarLinks, containers, dragRef }: HitContext) {
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
  return hit;
}

function keyboardSlots(recents: SidebarRecent[], linkProjectId: string | null, byId: (id: string | null) => SidebarRecent | undefined) {
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
  return slots;
}

type PointerContext = {
  canDrag: boolean;
  scopeKey: string;
  dragRef: RefObject<ChatDrag | null>;
  byId: (id: string | null) => SidebarRecent | undefined;
  begin: (id: string, keyboard: boolean) => void;
  dragHandlers: RefObject<{
    over: (target: DropTarget | null) => void;
    drop: () => void;
    finish: () => void;
    hit: (x: number, y: number) => DropTarget | null;
  }>;
};

function pointerStarter({ canDrag, scopeKey, dragRef, byId, begin, dragHandlers }: PointerContext) {
  function startPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!canDrag || event.button !== 0 || dragRef.current) return;
    const pressed = event.target as HTMLElement;
    const row = pressed.closest<HTMLElement>("[data-chat-id]");
    const id = row?.dataset.chatId;
    if (!id || pressed.closest("a, input, [aria-haspopup]") || byId(id)?.pending) return;
    const start = { x: event.clientX, y: event.clientY };
    let started = false;
    const key = isLinkScopeKey(scopeKey) ? null : `${scopeKey}#${id}`;
    let onGrid: GridDropTarget | null = null;
    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
        started = true;
        begin(id, false);
      }
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
  return startPointer;
}

function holdPointer() {
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";
  window.getSelection()?.removeAllRanges();
}

function releasePointer() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

type ChatListDragProps = {
  recents: SidebarRecent[];
  scopeKey: string;
  linkProjectId: string | null;
  actions: ChatRowActions;
  collapsed: boolean;
  sidebarLinks: ReturnType<typeof useSidebarLinks>;
};

export function useChatListDrag({ recents, scopeKey, linkProjectId, actions, collapsed, sidebarLinks }: ChatListDragProps) {
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
  const links = sidebarLinks.links;
  const [drag, setDrag] = useState<ChatDrag | null>(null);
  const dragRef = useRef<ChatDrag | null>(null);
  const [mark, setMark] = useState<{ top: number; height: number; inPins: boolean } | null>(null);
  const [foreignMark, setForeignMark] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<string | null>(null);
  const canDrag = !collapsed && Boolean(actions.onPin);
  const byId = (id: string | null) => recents.find((item) => item.id === id);
  const otherList = (scope: string | undefined) => (scope === undefined ? undefined : sidebarLinks.lists().find((handle) => handle.scopeKey === scope));

  const live = useRef({ recents, actions, sidebarLinks });
  live.current = { recents, actions, sidebarLinks };
  const { targetChat, intentOf, pinSlot, describe } = dropModel({ recents, linkProjectId, links, sidebarLinks, byId, otherList });
  const hit = hitTest({ scopeKey, linkProjectId, sidebarLinks, containers, dragRef });
  const slots = keyboardSlots(recents, linkProjectId, byId);

  useEffect(() => {
    if (!linkProjectId) return;
    const handle: LinkListHandle = { scopeKey, containers, byId: (id) => live.current.recents.find((item) => item.id === id) };
    return sidebarLinks.register(handle);
  }, [scopeKey, linkProjectId]);

  const anchorAt = (top: number) => {
    const aside = listRef.current?.closest("aside")?.getBoundingClientRect();
    return { top: Math.max(8, top), left: (aside?.right ?? 0) + 8 };
  };

  const readLive = useEvent(() => live.current);
  const rowActions = useMemo(() => chatRowActions(actions, linkProjectId, scopeKey, readLive), [actions, linkProjectId, scopeKey, readLive]);

  function setDragState(next: ChatDrag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function begin(id: string, keyboard: boolean) {
    setDragState({ id, target: null, keyboard });
    document.documentElement.setAttribute("data-chat-drag", "");
    if (!keyboard) {
      holdPointer();
    }
    if (linkProjectId) sidebarLinks.refresh();
    setAnnouncement(keyboard ? `Picked up ${byId(id)?.label}. Arrow keys move it, Space drops it, Escape cancels.` : "");
  }

  function finish() {
    setDragState(null);
    document.documentElement.removeAttribute("data-chat-drag");
    releasePointer();
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

  const dragHandlers = useRef({ over, drop, finish, hit });
  useLayoutEffect(() => {
    dragHandlers.current = { over, drop, finish, hit };
  });
  const startPointer = pointerStarter({ canDrag, scopeKey, dragRef, byId, begin, dragHandlers });

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
      event.preventDefault();
      finish();
      setAnnouncement("Cancelled");
    } else if (event.key === "Tab") finish();
  }

  const keyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " && canDrag && (event.target as HTMLElement).matches("[data-row]")) event.preventDefault();
  };

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

  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id || containers().some((node) => node.contains(document.activeElement))) return;
    rowElement(id)?.querySelector<HTMLElement>("[data-row]")?.focus();
  }, [recents]);

  const intent = drag ? intentOf(drag) : "none";
  return { listRef, pinRef, drag, mark, foreignMark, announcement, rowActions, intent, startPointer, keyDown, keyUp };
}
