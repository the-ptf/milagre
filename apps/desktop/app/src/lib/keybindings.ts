import { useSyncExternalStore } from "react";
import {
  compileRules,
  commandForEvent,
  defaultKeybindings,
  hasCommandModifier,
  keyLabelFor,
  primaryKeyFor,
  type CompiledRule,
  type KeyEventLike,
  type KeybindingCommandId,
  type KeybindingRule,
  type KeybindingsState,
  type WhenContext,
} from "@milagre/shared/keybindings";
import { isMac } from "./shortcut-hints";

// The keys this Mac runs: its host's keybindings.json (core keybindings.cjs), followed live, so a change in Settings or
// a hand edit of the file takes effect at once. Until the host answers, the defaults.

let state: KeybindingsState = { path: "", rules: defaultKeybindings(), issues: [] };
let compiled: CompiledRule[] = compileRules(state.rules);
let started = false;
const listeners = new Set<() => void>();

/** Takes a host's answer; a host without keybindings answers nothing, and the defaults stay. */
function apply(next: KeybindingsState | null | undefined) {
  if (!next || !Array.isArray(next.rules)) return;
  state = next;
  compiled = compileRules(next.rules);
  listeners.forEach((notify) => notify());
}

function start() {
  if (started) return;
  started = true;
  window.milagre.onKeybindings?.(apply);
  void window.milagre
    .readKeybindings?.()
    .then(apply)
    .catch(() => {});
}

function subscribe(notify: () => void) {
  start();
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** This Mac's keybindings, live. */
export function useKeybindings(): KeybindingsState {
  return useSyncExternalStore(subscribe, () => state);
}

// What the app tells the `when` keys about itself; focus is read from the document as a key goes down.
let appContext: WhenContext = {};
/** Sets the app's part of the `when` context: chatView, linkOpen, gridShown. */
export function setKeyContext(next: WhenContext) {
  appContext = { ...appContext, ...next };
}

function focusContext(): WhenContext {
  const active = document.activeElement;
  const element = active instanceof HTMLElement ? active : null;
  const terminalFocus = Boolean(element?.closest("[data-terminal-body], .xterm"));
  const composerFocus = Boolean(element?.closest("[data-prompt-editor]"));
  const editableFocus = terminalFocus || composerFocus || Boolean(element?.closest("input, textarea, select, [contenteditable=true], [contenteditable='']"));
  return { terminalFocus, composerFocus, editableFocus };
}

/** The `when` context now. */
function keyContext(): WhenContext {
  return { isMac, ...appContext, ...focusContext() };
}

/**
 * The command a key press runs on this Mac, or null. A key with no ⌘, Ctrl or ⌥ (a hand-edited `"k"`) never runs while
 * a field has the keyboard, so typing still types.
 */
export function shortcutCommand(event: KeyEventLike): KeybindingCommandId | null {
  start();
  const context = keyContext();
  const command = commandForEvent(compiled, event, context, isMac);
  if (!command || !context.editableFocus) return command;
  const rule = compiled.findLast((item) => item.command === command);
  return rule && hasCommandModifier(rule.key) ? command : null;
}

/** How a command's key reads in a hint (`⇧⌘D`), or undefined while it has none. */
export function shortcutLabel(rules: readonly KeybindingRule[], command: KeybindingCommandId): string | undefined {
  const key = primaryKeyFor(rules, command);
  return (key && keyLabelFor(key, isMac)) || undefined;
}

/** A command's key as its hint reads, live. */
export function useShortcutLabel(command: KeybindingCommandId): string | undefined {
  return shortcutLabel(useKeybindings().rules, command);
}

/** The Chat a `chat.jump.N` command opens, from 0, or null for any other command. */
export function chatJumpIndex(command: KeybindingCommandId | null): number | null {
  const match = command ? /^chat\.jump\.([1-9])$/.exec(command) : null;
  return match ? Number(match[1]) - 1 : null;
}

/** The `chat.jump.N` command of the Chat at `index` (from 0), for its row's hint. */
export const chatJumpCommand = (index: number) => `chat.jump.${index + 1}` as KeybindingCommandId;
