import { preferenceStorage as localStorage } from "../../lib/preference-storage.ts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const PANEL_WIDTHS = {
  changes: { min: 280, default: 320, max: 640 },
  orchestrator: { min: 240, default: 300, max: 560 },
  simulator: { min: 320, default: 400, max: 800 },
  browser: { min: 360, default: 440, max: 1400 },
  artifacts: { min: 440, default: 560, max: 1400 },
} as const;

export type ResizablePanel = keyof typeof PANEL_WIDTHS;

export const MIN_CHAT_WIDTH = 420;

const key = (panel: ResizablePanel) => `milagre.panelWidth.${panel}`;

const clampPanelWidth = (panel: ResizablePanel, width: number) => {
  const { min, max } = PANEL_WIDTHS[panel];
  return Math.round(Math.min(max, Math.max(min, width)));
};

function readWidth(panel: ResizablePanel) {
  const saved = Number(localStorage.getItem(key(panel)));
  return Number.isFinite(saved) && saved > 0 ? clampPanelWidth(panel, saved) : PANEL_WIDTHS[panel].default;
}

const widths = new Map<ResizablePanel, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
globalThis.window?.addEventListener("storage", (event) => {
  const panel = (Object.keys(PANEL_WIDTHS) as ResizablePanel[]).find((name) => event.key === key(name));
  if (!panel) return;
  widths.set(panel, readWidth(panel));
  for (const listener of listeners) listener();
});

function savedWidth(panel: ResizablePanel) {
  let width = widths.get(panel);
  if (width === undefined) widths.set(panel, (width = readWidth(panel)));
  return width;
}

function saveWidth(panel: ResizablePanel, width: number) {
  const next = clampPanelWidth(panel, width);
  widths.set(panel, next);
  localStorage.setItem(key(panel), String(next));
  for (const listener of listeners) listener();
}

/**
 * The panel's width and what its ResizeHandle needs: while a drag runs, `width` follows the pointer in this panel only
 * (`resizing` true); the drag's end saves it for every panel of that kind.
 */
export function usePanelWidth(panel: ResizablePanel) {
  const saved = useSyncExternalStore(subscribe, () => savedWidth(panel));
  const [dragged, setDragged] = useState<number | null>(null);
  const onCommit = useCallback(
    (width: number) => {
      setDragged(null);
      saveWidth(panel, width);
    },
    [panel],
  );
  const [cap, setCap] = useState(Infinity);
  useEffect(() => {
    const fit = () => {
      const main = document.querySelector<HTMLElement>("[data-workspace-main]") ?? document.querySelector<HTMLElement>("[data-chat-pane]");
      if (!main) return;
      const chat = main.getBoundingClientRect().width;
      setCap((current) => Math.max(PANEL_WIDTHS[panel].min, Math.min(savedWidth(panel), current) + chat - MIN_CHAT_WIDTH));
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [panel]);
  return {
    width: dragged ?? Math.min(saved, cap),
    resizing: dragged !== null,
    min: PANEL_WIDTHS[panel].min,
    reset: PANEL_WIDTHS[panel].default,
    onResize: setDragged,
    onCommit,
  };
}

export function roomToWiden(panel: ResizablePanel, width: number) {
  const main = document.querySelector<HTMLElement>("[data-workspace-main]") ?? document.querySelector<HTMLElement>("[data-chat-pane]");
  const chat = main?.getBoundingClientRect().width ?? Infinity;
  return Math.min(PANEL_WIDTHS[panel].max, width + Math.max(0, chat - MIN_CHAT_WIDTH));
}
