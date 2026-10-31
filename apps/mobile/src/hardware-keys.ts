import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Platform, findNodeHandle, type TextInputInstance } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import {
  evaluateWhen,
  keybindingCommand,
  parseKey,
  parseWhen,
  type KeybindingCommandId,
  type KeybindingRule,
  type WhenContext,
} from "@milagre/shared/keybindings";

// UIKeyCommand's inputs for the keys that aren't a character.
const INPUTS: Record<string, string> = {
  arrowleft: "UIKeyInputLeftArrow",
  arrowright: "UIKeyInputRightArrow",
  arrowup: "UIKeyInputUpArrow",
  arrowdown: "UIKeyInputDownArrow",
  escape: "UIKeyInputEscape",
  enter: "\r",
  tab: "\t",
  space: " ",
  backspace: "\b",
  delete: "UIKeyInputDelete",
  home: "UIKeyInputHome",
  end: "UIKeyInputEnd",
  pageup: "UIKeyInputPageUp",
  pagedown: "UIKeyInputPageDown",
};
const IPAD: WhenContext = { isIpad: true };

/**
 * The hardware keyboard shortcuts: the rules of the Mac's keybindings.json for the commands an iPad has (`mobile` in
 * the catalog), whose `when` holds on an iPad. Holding ⌘ lists them by title. An id is `<command>#<n>`.
 */
function hardwareShortcuts(rules: readonly KeybindingRule[]): Shortcut[] {
  return rules.flatMap((rule, index) => {
    const command = keybindingCommand(rule.command);
    const shortcut = parseKey(rule.key);
    if (!command?.mobile || !shortcut) return [];
    if (rule.when) {
      const tree = parseWhen(rule.when);
      if (!tree || !evaluateWhen(tree, IPAD)) return [];
    }
    const input = INPUTS[shortcut.key] ?? (/^f([0-9]+)$/.test(shortcut.key) ? `UIKeyInputF${shortcut.key.slice(1)}` : shortcut.key);
    const modifiers = [
      ...(shortcut.mod || shortcut.meta ? ["command"] : []),
      ...(shortcut.ctrl ? ["control"] : []),
      ...(shortcut.alt ? ["alt"] : []),
      ...(shortcut.shift ? ["shift"] : []),
    ];
    return [{ id: `${rule.command}#${index}`, input, modifiers, title: command.title }];
  });
}

/** The command of a shortcut id. */
const commandOf = (id: string) => id.split("#")[0] as KeybindingCommandId;

type Shortcut = { id: string; input: string; modifiers: readonly string[]; title: string };
type HardwareKeysModule = {
  addListener(event: "returnKey", listener: (event: { target: number }) => void): EventSubscription;
  addListener(event: "shortcut", listener: (event: { id: string }) => void): EventSubscription;
  attachReturnAsync: (target: number) => Promise<boolean>;
  detachReturnAsync: (target: number) => Promise<void>;
  setShortcutsAsync: (shortcuts: Shortcut[]) => Promise<void>;
};
// Builds older than the iPad one have no module: Return keeps adding a line and there are no shortcuts.
const native = Platform.OS === "ios" ? requireOptionalNativeModule<HardwareKeysModule>("MilagreHardwareKeys") : null;

/** The Chat a `chat.jump.N` command opens, from 0, or null for the others. */
export function chatShortcutIndex(command: KeybindingCommandId) {
  const match = /^chat\.jump\.([1-9])$/.exec(command);
  return match ? Number(match[1]) - 1 : null;
}

/**
 * Offers `rules`' shortcuts while mounted, again each time they change, and hands each press's command to
 * `onShortcut`; mount it once, at the root.
 */
export function useHardwareShortcuts(rules: readonly KeybindingRule[], onShortcut: (command: KeybindingCommandId) => void) {
  const latest = useRef(onShortcut);
  useEffect(() => {
    latest.current = onShortcut;
  }, [onShortcut]);
  useEffect(() => {
    if (!native) return;
    const subscription = native.addListener("shortcut", ({ id }) => {
      if (keybindingCommand(commandOf(id))?.mobile) latest.current(commandOf(id));
    });
    return () => {
      subscription.remove();
      void native.setShortcutsAsync([]).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (native) void native.setShortcutsAsync(hardwareShortcuts(rules)).catch(() => {});
  }, [rules]);
}

/**
 * Return on a hardware keyboard calls `onReturn` instead of adding a line, as Enter sends on desktop. Shift+Return still
 * adds one, and so does the on-screen keyboard's return key. Call `attach` on the field's layout and focus.
 */
export function useReturnKey(ref: RefObject<TextInputInstance | null>, onReturn?: () => void) {
  const target = useRef<number | null>(null);
  const latest = useRef(onReturn);
  const revision = useRef(0);
  const retryFrame = useRef<number | null>(null);
  const enabled = Boolean(onReturn);
  useEffect(() => {
    latest.current = onReturn;
  }, [onReturn]);
  const attach = useCallback(() => {
    if (!native || !enabled) return;
    const current = ++revision.current;
    if (retryFrame.current !== null) cancelAnimationFrame(retryFrame.current);
    retryFrame.current = null;
    const attempt = (remaining: number) => {
      if (revision.current !== current) return;
      const tag = findNodeHandle(ref.current) ?? null;
      const retry = () => {
        if (revision.current !== current) return;
        target.current = null;
        if (remaining > 0)
          retryFrame.current = requestAnimationFrame(() => {
            retryFrame.current = null;
            attempt(remaining - 1);
          });
      };
      if (tag === null) {
        if (target.current !== null) void native.detachReturnAsync(target.current).catch(() => {});
        retry();
        return;
      }
      if (target.current !== null && target.current !== tag) void native.detachReturnAsync(target.current).catch(() => {});
      target.current = tag;
      // Fabric can replace the backing UITextView without replacing the React tag. Bind again on focus/layout instead
      // of treating a cached tag as proof of attachment. A layout can also arrive before the native view is registered.
      void native.attachReturnAsync(tag).then((attached) => {
        if (!attached) retry();
      }, retry);
    };
    attempt(2);
  }, [ref, enabled]);
  useEffect(() => {
    if (!native || !enabled) return;
    const subscription = native.addListener("returnKey", (event) => {
      if (event.target === target.current) latest.current?.();
    });
    attach();
    return () => {
      revision.current++;
      if (retryFrame.current !== null) cancelAnimationFrame(retryFrame.current);
      retryFrame.current = null;
      subscription.remove();
      if (target.current !== null) void native.detachReturnAsync(target.current).catch(() => {});
      target.current = null;
    };
  }, [enabled, attach]);
  return { attach };
}
