/** Where a key pressed in a Terminal goes: to the shell, to the app, or to the clipboard. */
export type TerminalKey = "shell" | "app" | "copy" | "paste";

type Key = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/**
 * ⌘ shortcuts belong to the app on macOS, where ⌘C and ⌘V go through the window's Edit menu. Other platforms have no
 * such menu, so copy and paste happen here: Ctrl+Shift+C and V everywhere, and on Windows also Ctrl+V, and Ctrl+C while
 * text is selected. With nothing selected Ctrl+C still interrupts the program in front.
 */
export function terminalKey(event: Key, platform: { mac: boolean; windows: boolean }, selected: boolean): TerminalKey {
  if (platform.mac) return event.metaKey ? "app" : "shell";
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey) return key === "c" ? "copy" : key === "v" ? "paste" : "app";
  // AltGr reaches a Windows window as Ctrl+Alt, and it types characters.
  if (!platform.windows || !event.ctrlKey || event.altKey) return "shell";
  if (key === "c" && selected) return "copy";
  return key === "v" ? "paste" : "shell";
}
