import type { KeybindingCommandId } from "@milagre/shared/keybindings";

export type Command = {
  id: string;
  label: string;
  group: string;
  detail?: string;
  /** What the command is for, in a sentence: shown under the label on the highlighted row only, never in the right column. */
  hint?: string;
  keywords?: string;
  /** The keybinding command whose key the row shows and runs it with. */
  keybinding?: KeybindingCommandId;
  /** The matched text inside `label`, bolded in the palette. */
  highlight?: [start: number, end: number];
  icon:
    | "chat"
    | "add"
    | "folder"
    | "settings"
    | "git"
    | "editor"
    | "copy"
    | "unread"
    | "search"
    | "message"
    | "reload"
    | "routines"
    | "usage"
    | "newChat"
    | "storage"
    | "triage"
    | "terminal"
    | "link"
    | "pullRequest"
    | "folderAdd"
    | "canvas";
  run: () => void | Promise<unknown>;
  /** Listed only once something is typed: every Settings row would bury the actions in an empty palette. */
  searchOnly?: boolean;
};

/**
 * Match every word across the title, location and aliases, preserving the curated group order. An empty query lists
 * everything but the search-only rows. Those don't match on their group's name, so "settings" finds the Settings
 * actions and pages, not every row in them.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return commands.filter((command) => !command.searchOnly);
  return commands.filter((command) => {
    const text =
      `${command.label} ${command.detail ?? ""} ${command.hint ?? ""} ${command.keywords ?? ""} ${command.searchOnly ? "" : command.group}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
