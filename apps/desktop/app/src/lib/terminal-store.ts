import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { useSyncExternalStore } from "react";
import type { TerminalInfo } from "@milagre/shared/terminal";

// Each Chat's Terminals as the host lists them, which one its panel shows, and whether its panel is open. The panel's
// height is one for every Chat. The host owns the Terminals; this only mirrors them for the window.

const TERMINAL_HEIGHT_KEY = "milagre.terminal.height";
export const TERMINAL_HEIGHT = { initial: 280, min: 120 };

/** `picking`: the panel shows the Worktree choice for a new Terminal (a shared Chat has one per Project). */
type ChatTerminals = { terminals: TerminalInfo[]; active: string | null; open: boolean; picking: boolean };
type State = { chats: Record<string, ChatTerminals>; height: number };

const EMPTY: ChatTerminals = { terminals: [], active: null, open: false, picking: false };

function savedHeight(): number {
  const value = Number(localStorage?.getItem(TERMINAL_HEIGHT_KEY));
  return Number.isFinite(value) && value >= TERMINAL_HEIGHT.min ? value : TERMINAL_HEIGHT.initial;
}

let state: State = { chats: {}, height: savedHeight() };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}
function patchChat(chatId: string, patch: Partial<ChatTerminals>) {
  const current = state.chats[chatId] ?? EMPTY;
  set({ ...state, chats: { ...state.chats, [chatId]: { ...current, ...patch } } });
}

export function chatTerminals(chatId: string | null): ChatTerminals {
  return (chatId && state.chats[chatId]) || EMPTY;
}

export function useChatTerminals(chatId: string | null) {
  return useSyncExternalStore(subscribe, () => chatTerminals(chatId));
}

export function useTerminalHeight() {
  return useSyncExternalStore(subscribe, () => state.height);
}

/** Sizes the panel as it is dragged; `saveTerminalHeight` keeps the size it was dropped at. */
export function setTerminalHeight(height: number) {
  const next = Math.max(TERMINAL_HEIGHT.min, Math.round(height));
  if (next === state.height) return;
  set({ ...state, height: next });
}

export function saveTerminalHeight() {
  localStorage?.setItem(TERMINAL_HEIGHT_KEY, String(state.height));
}

/** Takes the host's list. The shown Terminal stays if it still runs, else the newest one is shown; with none left the panel closes. */
export function applyTerminalList(chatId: string, terminals: TerminalInfo[]) {
  const current = state.chats[chatId] ?? EMPTY;
  const active = terminals.some((terminal) => terminal.id === current.active) ? current.active : (terminals.at(-1)?.id ?? null);
  patchChat(chatId, { terminals, active, open: current.open && (terminals.length > 0 || current.picking) });
}

export function addTerminal(terminal: TerminalInfo) {
  const current = state.chats[terminal.chatId] ?? EMPTY;
  const terminals = current.terminals.some((item) => item.id === terminal.id) ? current.terminals : [...current.terminals, terminal];
  patchChat(terminal.chatId, { terminals, active: terminal.id, open: true, picking: false });
}

export function updateTerminal(terminal: TerminalInfo) {
  const current = state.chats[terminal.chatId];
  if (!current?.terminals.some((item) => item.id === terminal.id)) return;
  const old = current.terminals.find((item) => item.id === terminal.id)!;
  if (old.title === terminal.title && old.busy === terminal.busy) return;
  patchChat(terminal.chatId, { terminals: current.terminals.map((item) => (item.id === terminal.id ? terminal : item)) });
}

export function removeTerminal(chatId: string, terminalId: string) {
  const current = state.chats[chatId];
  if (!current) return;
  applyTerminalList(
    chatId,
    current.terminals.filter((item) => item.id !== terminalId),
  );
}

export function showTerminal(chatId: string, terminalId: string) {
  patchChat(chatId, { active: terminalId, open: true });
}

export function setTerminalPanelOpen(chatId: string, open: boolean) {
  patchChat(chatId, open ? { open } : { open, picking: false });
}

export function setTerminalPicking(chatId: string, picking: boolean) {
  const current = state.chats[chatId] ?? EMPTY;
  // Dismissing the choice closes a panel that had nothing else to show.
  patchChat(chatId, { picking, open: picking || (current.open && current.terminals.length > 0) });
}
