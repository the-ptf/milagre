import type { Command } from "./commands.ts";
import { preferenceStorage } from "./preference-storage.ts";

const STORAGE_KEY = "milagre.recentCommands";
export const RECENT_LIMIT = 5;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function recentCommandIds(storage: Storage = preferenceStorage): string[] {
  try {
    const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string, storage: Storage = preferenceStorage) {
  const ids = [id, ...recentCommandIds(storage).filter((saved) => saved !== id)].slice(0, RECENT_LIMIT);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch (error) {
    console.warn("Could not save recent commands", error);
  }
}

export function recentCommands(commands: readonly Command[], ids: readonly string[]): Command[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  return ids.flatMap((id) => {
    const command = byId.get(id);
    return command ? [{ ...command, id: `recent:${id}`, group: "Recent", highlight: undefined, searchOnly: false }] : [];
  });
}

export const rememberedId = (command: Command) => (command.id.startsWith("recent:") ? command.id.slice("recent:".length) : command.id);
