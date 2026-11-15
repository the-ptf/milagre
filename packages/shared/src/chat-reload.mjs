export const RELOAD_HINT = "Reload to update skills, MCPs or login status";

export const RELOAD_TEXT = "Chat reloaded";

export function isChatReload(message) {
  return message?.context?.kind === "reload";
}
