import { useEffect, useRef, type RefObject } from "react";
import { Platform, findNodeHandle, type TextInputInstance } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

/** The hardware keyboard shortcuts, as desktop has them. Holding ⌘ on an iPad lists them by title. */
const SHORTCUTS = [
  { id: "new-chat", input: "n", modifiers: ["command"], title: "New Chat" },
  { id: "search", input: "k", modifiers: ["command"], title: "Search Chats" },
  { id: "sidebar", input: "b", modifiers: ["command"], title: "Toggle Sidebar" },
  { id: "changes", input: "d", modifiers: ["command", "shift"], title: "Changes" },
  { id: "settings", input: ",", modifiers: ["command"], title: "Settings" },
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `chat-${index + 1}`,
    input: String(index + 1),
    modifiers: ["command"],
    title: `Open Chat ${index + 1}`,
  })),
] as const;
export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

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

/** The ⌘ number of a `chat-N` shortcut, or null for the others. */
export function chatShortcutIndex(id: string) {
  const match = /^chat-([1-9])$/.exec(id);
  return match ? Number(match[1]) - 1 : null;
}

/** Offers the shortcuts while mounted and hands each press to `onShortcut`; mount it once, at the root. */
export function useHardwareShortcuts(onShortcut: (id: ShortcutId) => void) {
  const latest = useRef(onShortcut);
  useEffect(() => {
    latest.current = onShortcut;
  }, [onShortcut]);
  useEffect(() => {
    if (!native) return;
    void native.setShortcutsAsync(SHORTCUTS.map((item) => ({ ...item, modifiers: [...item.modifiers] }))).catch(() => {});
    const subscription = native.addListener("shortcut", ({ id }) => {
      if (SHORTCUTS.some((item) => item.id === id)) latest.current(id as ShortcutId);
    });
    return () => {
      subscription.remove();
      void native.setShortcutsAsync([]).catch(() => {});
    };
  }, []);
}

/**
 * Return on a hardware keyboard calls `onReturn` instead of adding a line, as Enter sends on desktop. Shift+Return still
 * adds one, and so does the on-screen keyboard's return key. Call `attach` on the field's layout and focus.
 */
export function useReturnKey(ref: RefObject<TextInputInstance | null>, onReturn?: () => void) {
  const target = useRef<number | null>(null);
  const latest = useRef(onReturn);
  const enabled = Boolean(onReturn);
  useEffect(() => {
    latest.current = onReturn;
  }, [onReturn]);
  useEffect(() => {
    if (!native || !enabled) return;
    const subscription = native.addListener("returnKey", (event) => {
      if (event.target === target.current) latest.current?.();
    });
    return () => {
      subscription.remove();
      if (target.current !== null) void native.detachReturnAsync(target.current).catch(() => {});
      target.current = null;
    };
  }, [enabled]);
  const attach = () => {
    if (!native || !latest.current) return;
    const tag = findNodeHandle(ref.current) ?? null;
    if (tag === null || tag === target.current) return;
    if (target.current !== null) void native.detachReturnAsync(target.current).catch(() => {});
    target.current = tag;
    void native
      .attachReturnAsync(tag)
      .then((attached) => {
        if (!attached && target.current === tag) target.current = null;
      })
      .catch(() => {
        if (target.current === tag) target.current = null;
      });
  };
  return { attach };
}
