// The line a Chat shows where the user reloaded its agent (context kind "reload"). Types: chat-reload.d.mts.

/** What the menu item's tooltip says the reload is for. */
export const RELOAD_HINT = "Reload to update skills, MCPs or login status.";

/** The line as text: the message body, and the label screen readers and the transcript use. */
export const RELOAD_TEXT = "Chat reloaded";

export function isChatReload(message) {
  return message?.context?.kind === "reload";
}
