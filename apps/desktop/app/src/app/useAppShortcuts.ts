import { useEffect, useRef, type RefObject } from "react";
import { chatBookmark } from "@milagre/shared/subchats";
import type { SettingsSection } from "../components/Settings";
import { isDraftTileKey } from "../lib/chat-grid";
import { chatJumpIndex, shortcutCommand } from "../lib/keybindings";
import { appShortcutsBlocked, isModalOpen } from "../lib/modal";
import { toggleTheme } from "../lib/settings";
import { useEvent } from "../lib/stable";
import { newTerminal } from "../lib/terminal-actions";

type FamilySessions = Parameters<typeof chatBookmark>[0];

export type AppShortcutContext = {
  setSettingsOpen: (open: boolean) => void;
  settingsOpenRef: RefObject<boolean>;
  openSettingsAt: (section: SettingsSection) => void;
  linkOpenRef: RefObject<unknown>;
  shownTilesRef: RefObject<readonly string[]>;
  gridFocusKeyRef: RefObject<string | null | undefined>;
  familySessionsRef: RefObject<FamilySessions | undefined>;
  changesAvailableRef: RefObject<boolean>;
  terminalChatRef: RefObject<string | null>;
  findRef: RefObject<{ open: boolean; canOpen: boolean }>;
  changes: { toggle: () => void; closeDiff: () => void };
  setView: (view: "chat" | "canvas" | "routines") => void;
  openLinkedChat: (key: string) => void;
  openAlone: (key: string) => void;
  openFind: () => void;
  setFindOpen: (open: boolean) => void;
  openCommandPalette: () => void;
  startNewChat: () => unknown;
  openProject: () => unknown;
  setNotice: (notice: string | null) => void;
};

export type EscapeContext = {
  settingsOpenRef: RefObject<boolean>;
  linkOpenRef: RefObject<unknown>;
  findRef: RefObject<{ open: boolean; canOpen: boolean }>;
  setFindOpen: (open: boolean) => void;
  runPaneOpen: boolean;
  closeRunPane: () => void;
  view: "chat" | "canvas" | "routines";
  routineId: string | null;
  setRoutineId: (id: string | null) => void;
  setView: (view: "chat" | "canvas" | "routines") => void;
  /** Escape on the open Chat: deny its approval, dismiss its question, or stop its turn. */
  escapeOpenChat: (event: KeyboardEvent) => void;
  /** What the Escape effect re-subscribes on, as before the split. */
  deps: unknown[];
};

function focusGridNeighbour(ctx: AppShortcutContext, step: -1 | 1, event: KeyboardEvent) {
  const tiles = ctx.shownTilesRef.current;
  if (tiles.length < 2) return;
  event.preventDefault();
  const at = tiles.indexOf(ctx.gridFocusKeyRef.current ?? "");
  // A new Chat's draft tile is left, never landed on: it has no Chat to open.
  const others = tiles.filter((key, index) => index === at || !isDraftTileKey(key));
  const from = others.indexOf(ctx.gridFocusKeyRef.current ?? "");
  const next = others[(from + step + others.length) % others.length];
  if (next && next !== ctx.gridFocusKeyRef.current) ctx.openLinkedChat(next);
}

function runChatShortcut(ctx: AppShortcutContext, command: string, event: KeyboardEvent) {
  if (command === "changes.toggle") {
    if (!ctx.changesAvailableRef.current) return;
    event.preventDefault();
    // Shows or hides the panel on the view it was left on (Changes or the PR), never switching it.
    ctx.changes.toggle();
  } else if (command === "canvas.open") {
    event.preventDefault();
    ctx.changes.closeDiff();
    ctx.setView("canvas");
  } else if (command === "usage.open") {
    event.preventDefault();
    ctx.changes.closeDiff();
    ctx.openSettingsAt("usage");
  } else if (command === "chat.parent") {
    // The bookmark's way up: the open Chat's nearest listed ancestor, alone. Nothing on a Chat that has none.
    const open = ctx.gridFocusKeyRef.current;
    const parent = open && !isDraftTileKey(open) ? chatBookmark(ctx.familySessionsRef.current, open)?.parent : undefined;
    if (!parent) return;
    event.preventDefault();
    ctx.openAlone(parent);
  } else if (command === "chat.find") {
    if (!ctx.findRef.current.canOpen) return;
    event.preventDefault();
    ctx.openFind();
  } else if (command === "commandPalette.toggle") {
    event.preventDefault();
    ctx.openCommandPalette();
  } else if (command === "chat.new") {
    event.preventDefault();
    ctx.startNewChat();
  } else if (command === "project.add") {
    event.preventDefault();
    void ctx.openProject();
  } else if (command === "terminal.new" && ctx.terminalChatRef.current) {
    event.preventDefault();
    newTerminal(ctx.terminalChatRef.current, undefined, ctx.setNotice);
  }
}

function handleShortcut(ctx: AppShortcutContext, event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || appShortcutsBlocked()) return;
  const command = shortcutCommand(event);
  if (!command) return;
  // A Link's workspace takes its own Chat shortcuts (Changes, New Chat, search, New Terminal, Find) and has its own
  // canvas and grid; the window-wide ones, Settings and the theme, still work over it.
  const inLink = Boolean(ctx.linkOpenRef.current);
  if (command === "settings.open") {
    event.preventDefault();
    ctx.setSettingsOpen(true);
    return;
  }
  if (command === "theme.toggle") {
    event.preventDefault();
    toggleTheme();
    return;
  }
  // Over Settings, ⌘K opens the palette on top of it; any other app shortcut closes Settings and runs in the Chat.
  if (ctx.settingsOpenRef.current && command !== "commandPalette.toggle") ctx.setSettingsOpen(false);
  if (inLink) return;
  if (command === "grid.focusPrevious" || command === "grid.focusNext") {
    focusGridNeighbour(ctx, command === "grid.focusPrevious" ? -1 : 1, event);
    return;
  }
  runChatShortcut(ctx, command, event);
}

function handleEscape(ctx: EscapeContext, event: KeyboardEvent) {
  // A menu, picker or search that Escape closed has already consumed it.
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  // The Settings modal closes on its own Escape (the dialog's cancel); nothing behind it, a running turn least of all, takes it.
  if (ctx.settingsOpenRef.current) return;
  // The Link's workspace takes every Escape over a Link.
  if (ctx.linkOpenRef.current) return;
  if (ctx.findRef.current.open) {
    event.preventDefault();
    ctx.setFindOpen(false);
    return;
  }
  // A Run Chat beside its Routine's page closes first, then the page goes back to the Routines page.
  if (ctx.runPaneOpen) {
    event.preventDefault();
    ctx.closeRunPane();
    return;
  }
  if (ctx.view === "routines" && ctx.routineId) {
    event.preventDefault();
    ctx.setRoutineId(null);
    return;
  }
  if (ctx.view === "canvas" || ctx.view === "routines") {
    event.preventDefault();
    ctx.setView("chat");
    return;
  }
  ctx.escapeOpenChat(event);
}

/**
 * The window's keyboard shortcuts. The shortcut listener subscribes once, with the first render's context, and reads
 * the refs it carries; the Escape listener re-subscribes on `escape.deps`.
 */
export function useAppShortcuts(shortcuts: AppShortcutContext, escape: EscapeContext) {
  // The main process sends on the app's frame-wide keys (Settings, the theme, the canvas, the grid, the side panels) pressed
  // in any frame, including an embedded one (a design, an HTML reply, the simulator) the window's listeners never see;
  // replayed here, every handler takes them as if pressed in the window.
  useEffect(
    () =>
      window.milagre.onAppShortcut?.(({ key, code, meta, control, alt, shift }) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: code ?? "",
            metaKey: meta,
            ctrlKey: control,
            altKey: alt,
            shiftKey: shift,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
    [],
  );
  const first = useRef(shortcuts);
  useEffect(() => {
    const ctx = first.current;
    const listener = (event: KeyboardEvent) => handleShortcut(ctx, event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  useEffect(() => {
    const ctx = escapeRef.current;
    const listener = (event: KeyboardEvent) => handleEscape(ctx, event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-subscribes on the caller's list, as the listener did inside App
  }, escape.deps);
}

/** ⌘1…⌘9: the nth Chat in the sidebar's visible order, which the sidebar reports through the returned setter. */
export function useJumpToChat({ enabled, openChat }: { enabled: () => boolean; openChat: (sessionId: number) => void }) {
  const jumpChats = useRef<string[]>([]);
  const setJumpChats = useEvent((ids: string[]) => {
    jumpChats.current = ids;
  });
  const jumpToChat = useEvent((event: KeyboardEvent) => {
    if (!enabled() || event.defaultPrevented || event.isComposing) return;
    const index = chatJumpIndex(shortcutCommand(event));
    if (index === null) return;
    if (isModalOpen() || document.querySelector('[role="menu"], [aria-label="Chat name"]')) return;
    const chat = jumpChats.current[index];
    if (!chat) return;
    event.preventDefault();
    openChat(Number(chat));
  });
  useEffect(() => {
    window.addEventListener("keydown", jumpToChat);
    return () => window.removeEventListener("keydown", jumpToChat);
  }, [jumpToChat]);
  return setJumpChats;
}
