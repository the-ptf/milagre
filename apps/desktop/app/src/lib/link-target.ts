import { getSettings } from "./settings.ts";

/**
 * Whether a click on a web link opens it in the Browser panel: Settings › Browser picks where links open, and ⌘-click
 * (Ctrl-click off macOS) opens the other one.
 */
export function opensInPanel(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return (getSettings().openLinksIn === "milagre") !== (event.metaKey || event.ctrlKey);
}
