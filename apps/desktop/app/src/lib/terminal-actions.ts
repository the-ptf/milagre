import { useEffect } from "react";
import type { TerminalInfo } from "@milagre/shared/terminal";
import { ipcErrorMessage } from "@milagre/shared/result";
import { dispose, pruneTerminals } from "./terminal-sessions";
import { addTerminal, applyTerminalList, chatTerminals, setTerminalPanelOpen, setTerminalPicking } from "./terminal-store";
import { bridgeForKey } from "./computer-bridge";

/** A Worktree a new Terminal can start in; a shared Chat offers one per member Project. */
export type TerminalPlace = { path: string; label: string };

// The Terminal a new open should focus once its panel has shown it.
let focusNext: string | null = null;
export function takeFocusRequest(id: string) {
  if (focusNext !== id) return false;
  focusNext = null;
  return true;
}

// The Chats whose Terminal list this window holds as the host has it: read once, then kept by the host's terminal:changed
// events. A change to a Chat that isn't on screen (or arrives while its list is being read) counts it out, so showing it
// again reads it again; so does a host's reconnect, whose snapshot follows events this window may have missed.
const listed = new Set<string>();
const changes = new Map<string, number>();
let following = false;
function countChange(payload: { chatId?: string } | undefined) {
  if (!payload?.chatId) return;
  listed.delete(payload.chatId);
  changes.set(payload.chatId, (changes.get(payload.chatId) ?? 0) + 1);
}
function follow() {
  if (following || !window.milagre) return;
  following = true;
  window.milagre.onTerminalsChanged?.(countChange);
  window.milagre.onRuntimeSnapshot?.(() => listed.clear());
  window.milagre.onComputerEvent?.((event) => {
    if (event.channel === "terminal:changed") countChange(event.payload);
    else if (event.channel === "runtime:snapshot") listed.clear();
  });
}

async function refreshTerminals(chatId: string) {
  const change = changes.get(chatId) ?? 0;
  const { terminals } = await bridgeForKey(chatId).terminals.list({ chatId });
  pruneTerminals(chatId, new Set(terminals.map((terminal) => terminal.id)));
  applyTerminalList(chatId, terminals);
  if ((changes.get(chatId) ?? 0) === change) listed.add(chatId);
}

export async function openTerminal(chatId: string, cwd?: string): Promise<TerminalInfo> {
  const terminal = await bridgeForKey(chatId).terminals.open({ chatId, ...(cwd ? { cwd } : {}) });
  focusNext = terminal.id;
  addTerminal(terminal);
  return terminal;
}

/** ⌘T: a new Terminal in the Chat's Worktree, or the choice of Worktree when the Chat has several. */
export function newTerminal(chatId: string, places: TerminalPlace[] | undefined, notify: (message: string) => void) {
  if (places && places.length > 1) {
    setTerminalPicking(chatId, true);
    return;
  }
  void openTerminal(chatId, places?.[0]?.path).catch((error) => notify(`Couldn't open a Terminal: ${ipcErrorMessage(error)}`));
}

/** ⌘J: hides the panel, shows it again, or opens the first Terminal when the Chat has none. */
export function toggleTerminalPanel(chatId: string, places: TerminalPlace[] | undefined, notify: (message: string) => void) {
  const current = chatTerminals(chatId);
  if (current.open) setTerminalPanelOpen(chatId, false);
  else if (current.terminals.length) {
    if (current.active) focusNext = current.active;
    setTerminalPanelOpen(chatId, true);
  } else newTerminal(chatId, places, notify);
}

/** What the Chat's Terminals run that archiving would end; none when the host can't say. */
export async function busyTerminals(chatId: string): Promise<string[]> {
  try {
    const { terminals } = await bridgeForKey(chatId).terminals.list({ chatId });
    return terminals.filter((terminal) => terminal.busy).map((terminal) => terminal.title);
  } catch {
    return [];
  }
}

export async function closeTerminal(terminal: TerminalInfo) {
  dispose(terminal.id);
  await bridgeForKey(terminal.chatId)
    .terminals.close({ terminalId: terminal.id })
    .catch(() => {});
  await refreshTerminals(terminal.chatId).catch(() => {});
}

/**
 * Keeps the shown Chat's Terminals in step with the host: read when it is first shown (and again after it changed out of
 * sight), and whenever the host says they changed. A Chat shown again with nothing changed shows its list as it was.
 */
export function useTerminalSync(chatId: string | null) {
  useEffect(() => {
    if (!chatId) return;
    follow();
    if (!listed.has(chatId)) void refreshTerminals(chatId).catch(() => {});
    const changed = (payload: { chatId: string }) => {
      if (payload?.chatId === chatId) void refreshTerminals(chatId).catch(() => {});
    };
    const offLocal = window.milagre.onTerminalsChanged(changed);
    const offRemote = window.milagre.onComputerEvent?.((event) => {
      if (event.channel === "terminal:changed") changed(event.payload);
    });
    return () => {
      offLocal();
      offRemote?.();
    };
  }, [chatId]);
}
