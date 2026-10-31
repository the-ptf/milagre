import { useSyncExternalStore } from "react";

export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
export const shortcutModifier = isMac ? "⌘" : "Ctrl+";
export const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
/** How copy names the computer this window runs on, so a Windows or Linux user never reads "Mac". */
export const thisComputer = isMac ? "this Mac" : "this computer";
export const ThisComputer = isMac ? "This Mac" : "This computer";
export const computerNoun = isMac ? "Mac" : "computer";
/** The app that shows a folder: Finder, File Explorer, or the file manager of a Linux desktop. */
export const fileManager = isMac ? "Finder" : isWindows ? "File Explorer" : "file manager";
let visible = false;
const listeners = new Set<() => void>();

function setVisible(next: boolean) {
  if (visible === next) return;
  visible = next;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) {
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);
    window.addEventListener("blur", reset);
    window.addEventListener("pointerdown", reset, true);
    document.addEventListener("visibilitychange", reset);
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size) return;
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("blur", reset);
    window.removeEventListener("pointerdown", reset, true);
    document.removeEventListener("visibilitychange", reset);
    visible = false;
  };
}

function reset() {
  setVisible(false);
}
function keydown(event: KeyboardEvent) {
  const modifier = isMac ? "Meta" : "Control";
  if (event.key === modifier && !event.repeat && !event.isComposing && !event.altKey && !event.shiftKey && !(isMac ? event.ctrlKey : event.metaKey)) {
    setVisible(true);
  } else if (event.key !== modifier) {
    // A chord has started. Don't show hints again until the modifier is pressed anew.
    reset();
  }
}
function keyup(event: KeyboardEvent) {
  if (event.key === (isMac ? "Meta" : "Control") || !(isMac ? event.metaKey : event.ctrlKey)) reset();
}

/** Capture-phase listeners also see releases inside dialogs that consume keyboard events. */
export function useShortcutHints() {
  return useSyncExternalStore(
    subscribe,
    () => visible,
    () => false,
  );
}
