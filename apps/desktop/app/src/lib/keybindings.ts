import { useSyncExternalStore } from "react";
import {
  compileRules,
  commandForEvent,
  defaultKeybindings,
  hasCommandModifier,
  keyFromEvent,
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

let state: KeybindingsState = { path: "", rules: defaultKeybindings(), issues: [] };
let compiled: CompiledRule[] = compileRules(state.rules);
let started = false;
const listeners = new Set<() => void>();

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

export function useKeybindings(): KeybindingsState {
  return useSyncExternalStore(subscribe, () => state);
}

let appContext: WhenContext = {};
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
  const pressed = keyFromEvent(event, isMac);
  return pressed && hasCommandModifier(pressed) ? command : null;
}

export function shortcutLabel(rules: readonly KeybindingRule[], command: KeybindingCommandId): string | undefined {
  const key = primaryKeyFor(rules, command);
  return (key && keyLabelFor(key, isMac)) || undefined;
}

export function useShortcutLabel(command: KeybindingCommandId): string | undefined {
  return shortcutLabel(useKeybindings().rules, command);
}

export function chatJumpIndex(command: KeybindingCommandId | null): number | null {
  const match = command ? /^chat\.jump\.([1-9])$/.exec(command) : null;
  return match ? Number(match[1]) - 1 : null;
}

export const chatJumpCommand = (index: number) => `chat.jump.${index + 1}` as KeybindingCommandId;
