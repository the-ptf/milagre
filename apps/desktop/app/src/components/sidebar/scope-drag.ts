import { type PointerEvent as ReactPointerEvent } from "react";
import { type DropZone } from "@/lib/chat-list";

export const DRAG_THRESHOLD = 4;

export const DROP_HINTS = { "same-worktree": "Same worktree: a Link joins two different Worktrees", linked: "Already linked" };

export function dragScopeHeader(
  event: ReactPointerEvent<HTMLElement>,
  key: string,
  draggable: (scopeKey: string) => boolean,
  onDragging: (key: string | null) => void,
  onReorder: (key: string, beforeKey: string | null) => void,
) {
  const start = { x: event.clientX, y: event.clientY };
  let started = false;
  let target: { beforeKey: string | null; node: HTMLElement; half: "top" | "bottom" } | null = null;
  const line = document.createElement("div");
  line.dataset.scopeDropLine = "";
  line.className = "pointer-events-none fixed z-[70] h-0.5 rounded-full bg-accent";
  line.style.display = "none";
  const groups = () =>
    [...document.querySelectorAll<HTMLElement>("[data-sidebar-scope]")].filter((node) => {
      const scopeKey = node.dataset.sidebarScope;
      return scopeKey && (scopeKey === key || draggable(scopeKey));
    });
  const showLine = (node: HTMLElement, half: "top" | "bottom") => {
    const header = node.querySelector<HTMLElement>("[data-scope-toggle]")?.closest<HTMLElement>(".group\\/scope") ?? node;
    const rect = header.getBoundingClientRect();
    line.style.display = "";
    line.style.left = `${rect.left}px`;
    line.style.width = `${rect.width}px`;
    line.style.top = `${(half === "top" ? rect.top : rect.bottom) - 1}px`;
  };
  const hit = (_x: number, y: number) => {
    const all = groups();
    const others = all.filter((node) => node.dataset.sidebarScope !== key);
    const over = all.find((node) => {
      const rect = node.getBoundingClientRect();
      return y >= rect.top && y <= rect.bottom;
    });
    if (over?.dataset.sidebarScope === key) return null;
    if (over) {
      const rect = over.getBoundingClientRect();
      const half: "top" | "bottom" = y < rect.top + rect.height / 2 ? "top" : "bottom";
      const beforeKey = half === "top" ? over.dataset.sidebarScope! : (others[others.indexOf(over) + 1]?.dataset.sidebarScope ?? null);
      return { beforeKey, node: over, half };
    }
    const below = others.find((node) => node.getBoundingClientRect().top > y);
    if (below) return { beforeKey: below.dataset.sidebarScope!, node: below, half: "top" as const };
    const last = others.at(-1);
    return last ? { beforeKey: null, node: last, half: "bottom" as const } : null;
  };
  const move = (moveEvent: PointerEvent) => {
    if (!started) {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
      started = true;
      onDragging(key);
      document.body.appendChild(line);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    target = hit(moveEvent.clientX, moveEvent.clientY);
    if (target) showLine(target.node, target.half);
    else line.style.display = "none";
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", escape, true);
    line.remove();
    onDragging(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  const end = () => {
    const dropped = target;
    stop();
    if (!started) return;
    const swallow = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (dropped) onReorder(key, dropped.beforeKey);
  };
  const cancel = () => stop();
  const escape = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape" || !started) return;
    keyEvent.preventDefault();
    target = null;
    stop();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", escape, true);
}

export type DropTarget = { id: string | null; zone: DropZone; scope?: string };

export type ChatDrag = { id: string; target: DropTarget | null; keyboard: boolean };

export const sameTarget = (a: DropTarget | null, b: DropTarget | null) => a?.id === b?.id && a?.zone === b?.zone && a?.scope === b?.scope;
