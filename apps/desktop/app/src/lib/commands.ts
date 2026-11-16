import type { KeybindingCommandId } from "@milagre/shared/keybindings";

export type Command = {
  id: string;
  label: string;
  group: string;
  detail?: string;
  hint?: string;
  keywords?: string;
  keybinding?: KeybindingCommandId;
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
    | "canvas"
    | "orchestrator";
  run: () => void | Promise<unknown>;
  searchOnly?: boolean;
};

export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return commands.filter((command) => !command.searchOnly);
  return commands.filter((command) => {
    const text =
      `${command.label} ${command.detail ?? ""} ${command.hint ?? ""} ${command.keywords ?? ""} ${command.searchOnly ? "" : command.group}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}
