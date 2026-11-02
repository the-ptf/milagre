import type { KeybindingCommandId } from "@milagre/shared/keybindings";

export type Command = {
  id: string;
  label: string;
  group: string;
  detail?: string;
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
    | "triage";
  run: () => void | Promise<unknown>;
};

/** Match every word across the title, location and aliases, preserving the curated group order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = `${command.label} ${command.detail ?? ""} ${command.keywords ?? ""} ${command.group}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
