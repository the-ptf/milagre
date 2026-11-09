// The contract the bots module (packages/core/src/bots) shares with the desktop and the phone.
// Types: bots.d.mts.

/** The action classes that always wait for the user's sign-off. */
export const GATE_KINDS = Object.freeze(["merge", "publish", "post", "delete", "spend"]);
/** A sign-off nobody answered within this time counts as denied and shows "Expired". */
export const GATE_EXPIRY_MS = 3_600_000;
/** At most this many Chats a bot opened run at once. */
export const BOT_RUNNING_CHAT_CAP = 3;
/** MEMORY.md stays under both caps. */
export const MEMORY_LINE_CAP = 200;
export const MEMORY_BYTE_CAP = 24 * 1024;

/** A bot's id from its name: lowercase, runs of anything else than letters and digits become one dash. */
export function botIdFromName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True for a bot's thread and for a Chat a bot opened and still runs: neither tells the user when it finishes. */
export function isQuietChat(snapshot, chatKey) {
  if (!snapshot) return false;
  if (snapshot.bots?.some((bot) => `${bot.homePath}#${bot.threadSessionId}` === chatKey)) return true;
  return Boolean(snapshot.chats?.some((chat) => chat.chatKey === chatKey && chat.status !== "taken-over"));
}
