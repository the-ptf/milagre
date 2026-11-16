import { useEffect } from "react";
import type { TerminalInfo } from "@milagre/shared/terminal";
import { ipcErrorMessage } from "@milagre/shared/result";
import { dispose, pruneTerminals } from "./terminal-registry";
import { addTerminal, applyTerminalList, chatTerminals, setTerminalPanelOpen, setTerminalPicking } from "./terminal-store";
import { bridgeForKey } from "./computer-bridge";

export type TerminalPlace = { path: string; label: string };

let focusNext: string | null = null;
export function takeFocusRequest(id: string) {
  if (focusNext !== id) return false;
  focusNext = null;
  return true;
}

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

export function newTerminal(chatId: string, places: TerminalPlace[] | undefined, notify: (message: string) => void) {
  if (places && places.length > 1) {
    setTerminalPicking(chatId, true);
    return;
  }
  void openTerminal(chatId, places?.[0]?.path).catch((error) => notify(`Couldn't open a Terminal: ${ipcErrorMessage(error)}`));
}

export function toggleTerminalPanel(chatId: string, places: TerminalPlace[] | undefined, notify: (message: string) => void) {
  const current = chatTerminals(chatId);
  if (current.open) setTerminalPanelOpen(chatId, false);
  else if (current.terminals.length) {
    if (current.active) focusNext = current.active;
    setTerminalPanelOpen(chatId, true);
  } else newTerminal(chatId, places, notify);
}

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
