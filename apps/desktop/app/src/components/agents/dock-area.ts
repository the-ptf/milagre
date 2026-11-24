import { useEffect, useRef, useState } from "react";
import { onPanelResizeEnd, panelResizing } from "../../lib/panel-resizing.ts";

/**
 * Where the panels docked beside the chat go: the workspace between the sidebar and the git changes panel, which an
 * expanded Artifact panel fills; `right`, how much of the window's right edge the changes panel takes, so the docks sit to its
 * left and it stays the rightmost; `simulator`, what a docked simulator takes of the workspace, gap included; and `top`
 * and `bottom`, the sidebar card's, so every panel lines up with it.
 * From the right: the changes panel, a docked simulator, the Browser panel (`browser`, gap included), then the Artifact
 * panel. Each sits under the panels right of it, so one sliding in or out passes under its neighbours: Artifact and browser
 * z-[41], simulator z-[42], changes panel z-[43], all under the window's top strip (z-50).
 */
type DockArea = { left: number; right: number; width: number; simulator: number; browser: number; top: number; bottom: number };

export function useDockArea() {
  const [area, setArea] = useState<DockArea | null>(null);
  useEffect(() => {
    const main = document.querySelector<HTMLElement>("[data-workspace-main]") ?? document.querySelector<HTMLElement>("[data-chat-pane]");
    if (!main) return;
    const measure = () => {
      const rect = main.getBoundingClientRect();
      const right = document.querySelector("[data-changes-slot]")?.getBoundingClientRect().width ?? 0;
      const docked = document.querySelector("[data-slot=simulator-popover][data-docked]")?.getBoundingClientRect().width ?? 0;
      const browser = document.querySelector("[data-slot=browser-dock]")?.getBoundingClientRect().width ?? 0;
      const card = document.querySelector("aside[aria-label='Workspace navigation']")?.getBoundingClientRect();
      const sidebar = card && card.height > 0 ? card : null;
      setArea((current) => {
        const next: DockArea = {
          left: rect.left,
          right,
          width: window.innerWidth - rect.left - right,
          simulator: current && panelResizing() ? current.simulator : docked > 0.5 ? docked + 12 : 0,
          browser: current && panelResizing() ? current.browser : browser > 0.5 ? browser + 12 : 0,
          top: sidebar?.top ?? (card ? current?.top : undefined) ?? 40,
          bottom: sidebar ? window.innerHeight - sidebar.bottom : ((card ? current?.bottom : undefined) ?? 12),
        };
        return current && (Object.keys(next) as (keyof DockArea)[]).every((key) => current[key] === next[key]) ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    window.addEventListener("resize", measure);
    const offDragEnd = onPanelResizeEnd(measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      offDragEnd();
    };
  }, []);
  return area;
}

export const ARTIFACT_EXPANDED = "milagre:artifact-expanded";

export function useCloseWhenArtifactExpands(close: () => void) {
  useEffect(() => {
    window.addEventListener(ARTIFACT_EXPANDED, close);
    return () => window.removeEventListener(ARTIFACT_EXPANDED, close);
  }, [close]);
}

const MIN_CHAT_WIDTH = 420;

export function panelsToClose(open: { name: string; width: number; openedAt: number }[], room: number): string[] {
  const left = [...open].sort((a, b) => a.openedAt - b.openedAt);
  const closing: string[] = [];
  const width = () => left.reduce((total, panel) => total + panel.width, 0);
  while (left.length > 2 && room - width() < MIN_CHAT_WIDTH) closing.push(left.shift()!.name);
  return closing;
}

// The side panels open now (the Artifact panel, a docked simulator, the git changes panel), each with when it opened.
const openPanels = new Map<string, { width: number; openedAt: number; close: () => void }>();
let opening = 0;
function makeRoom() {
  const main = document.querySelector<HTMLElement>("[data-workspace-main]") ?? document.querySelector<HTMLElement>("[data-chat-pane]");
  const room = window.innerWidth - (main?.getBoundingClientRect().left ?? 0);
  for (const name of panelsToClose(
    [...openPanels].map(([name, panel]) => ({ name, ...panel })),
    room,
  )) {
    const panel = openPanels.get(name);
    openPanels.delete(name);
    panel?.close();
  }
}
let watching = false;

export function useSidePanelRoom(name: string, open: boolean, width: number, close: () => void) {
  const latest = useRef({ width, close });
  latest.current = { width, close };
  useEffect(() => {
    if (!watching) {
      watching = true;
      window.addEventListener("resize", makeRoom);
    }
    if (!open) return;
    openPanels.set(name, {
      get width() {
        return latest.current.width;
      },
      openedAt: ++opening,
      close: () => latest.current.close(),
    });
    makeRoom();
    return () => {
      openPanels.delete(name);
    };
  }, [name, open]);
}

/**
 * Where the docked panels render: in the app's own stacking context (DotBackground's), beside the git changes panel,
 * so their z-indexes order them against it. Rendered at the body, the whole app would count as one layer to them, and
 * they would slide over the changes panel. The body where there is no app around them (the Electron checks).
 */
export function dockLayer(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-dock-layer]") ?? document.body;
}
