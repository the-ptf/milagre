import { useEffect, useRef } from "react";
import { type DictationShortcutMode } from "@milagre/shared/dictation";
import { isModalOpen } from "./modal";
import { shortcutCommand } from "./keybindings";

// The Dictate shortcut (keybinding `dictation.toggle`, ⌥Space by default). One listener for the window; the key goes to
// the composer that has the keyboard, else the one dictating, else the visible one used last, so a grid of Chats or the
// Chats kept mounted off screen never all start at once.
//
// Hold to talk starts on the press and finishes on release of the key or any of its modifiers.
// Press to start, press to stop does what the mic button does.

export type DictationShortcutTarget = {
  root: () => HTMLElement | null;
  dictating: () => boolean;
  mode: () => DictationShortcutMode;
  start: () => void;
  /** Finishes the take; one that hasn't started recording yet finishes as soon as it does. */
  finish: () => void;
};

type Entry = DictationShortcutTarget & { usedAt: number };

const targets = new Set<Entry>();
const MODIFIERS = new Set(["Alt", "Meta", "Control", "Shift"]);
let held: { code: string; modifiers: string[]; entry: Entry } | null = null;
let installed = false;

function shown(entry: Entry) {
  const root = entry.root();
  return Boolean(root?.isConnected && root.getClientRects().length > 0 && root.checkVisibility());
}

/** The composer the key is for. */
function pickTarget<T extends { usedAt: number }>(
  entries: readonly T[],
  { focused, dictating, visible }: { focused: (entry: T) => boolean; dictating: (entry: T) => boolean; visible: (entry: T) => boolean },
): T | null {
  const candidates = entries.filter(visible);
  return candidates.find(focused) ?? candidates.find(dictating) ?? candidates.toSorted((a, b) => b.usedAt - a.usedAt)[0] ?? null;
}

function current() {
  const active = document.activeElement;
  return pickTarget([...targets], {
    focused: (entry) => Boolean(active && entry.root()?.contains(active)),
    dictating: (entry) => entry.dictating(),
    visible: shown,
  });
}

function onKeyDown(event: KeyboardEvent) {
  if (isModalOpen() || document.querySelector("[data-keybinding-recording]")) return;
  if (event.defaultPrevented || event.isComposing || shortcutCommand(event) !== "dictation.toggle") return;
  const entry = current();
  if (!entry) return;
  // ⌥Space would type a non-breaking space into the field.
  event.preventDefault();
  if (event.repeat || held) return;
  if (entry.dictating()) return entry.finish();
  entry.usedAt = Date.now();
  entry.start();
  if (entry.mode() === "hold") held = { code: event.code, modifiers: [...MODIFIERS].filter((key) => event.getModifierState(key)), entry };
}

function release() {
  const press = held;
  held = null;
  if (press) press.entry.finish();
}

function onKeyUp(event: KeyboardEvent) {
  if (!held) return;
  if (event.code !== held.code && !(MODIFIERS.has(event.key) && held.modifiers.includes(event.key))) return;
  event.preventDefault();
  release();
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Keys let go in another app never send their keyup here.
  window.addEventListener("blur", release);
}

/** Makes a composer answer the Dictate shortcut while it is mounted. */
export function useDictationShortcut(target: DictationShortcutTarget) {
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    install();
    const entry: Entry = {
      root: () => latest.current.root(),
      dictating: () => latest.current.dictating(),
      mode: () => latest.current.mode(),
      start: () => latest.current.start(),
      finish: () => latest.current.finish(),
      usedAt: 0,
    };
    targets.add(entry);
    const used = () => {
      entry.usedAt = Date.now();
    };
    const root = entry.root();
    root?.addEventListener("focusin", used);
    root?.addEventListener("pointerdown", used);
    return () => {
      targets.delete(entry);
      if (held?.entry === entry) held = null;
      root?.removeEventListener("focusin", used);
      root?.removeEventListener("pointerdown", used);
    };
  }, []);
}
