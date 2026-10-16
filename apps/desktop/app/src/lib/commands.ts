export type Command = {
  id: string;
  label: string;
  group: string;
  detail?: string;
  keywords?: string;
  shortcut?: string;
  /** The matched text inside `label`, bolded in the palette. */
  highlight?: [start: number, end: number];
  icon: "chat" | "add" | "folder" | "settings" | "git" | "editor" | "copy" | "unread" | "search" | "message" | "reload";
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
