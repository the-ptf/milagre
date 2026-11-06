// @ts-check
const { hiddenHere } = require("@milagre/shared/attention");

const NONE = new Set();
// Kept by the window in preferences (lib/hidden-projects.ts, lib/settings.ts).
const HIDDEN_KEYS = new Set(["milagre.hiddenRemoteScopes", "milagre.hiddenComputers", "milagre-settings"]);

/**
 * Which Chats this Mac's sidebar leaves out, for the notifier: a paired computer's Project hidden here, a computer
 * unchecked in Filters › Computers (while Other computers is on), and this Mac's hidden Projects as the window last
 * reported them (the host keeps that list). Read from preferences, so it holds before the window loads.
 * @param {{ get(key: string): string | null | undefined }} preferences
 */
function createHiddenChats(preferences) {
  /** @type {Map<string, { raw: string | null | undefined; value: unknown }>} */
  const parsed = new Map();
  const read = (/** @type {string} */ key) => {
    const raw = preferences.get(key);
    const cached = parsed.get(key);
    if (cached && cached.raw === raw) return cached.value;
    let value = null;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      /* a broken value hides nothing */
    }
    parsed.set(key, { raw, value });
    return value;
  };
  const list = (/** @type {string} */ key) => {
    const value = read(key);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
  };
  /** @type {Set<string>} */
  let reported = new Set();
  return {
    /** @param {unknown} paths */
    setReported(paths) {
      reported = new Set(Array.isArray(paths) ? paths.filter((item) => typeof item === "string" && item.length > 0) : []);
    },
    /** @param {string} key */
    affects: (key) => HIDDEN_KEYS.has(key),
    /** @param {string} chatId */
    isHidden(chatId) {
      const settings = /** @type {{ otherComputers?: unknown } | null} */ (read("milagre-settings"));
      const computers = settings?.otherComputers === true ? new Set(list("milagre.hiddenComputers")) : NONE;
      return hiddenHere(chatId, new Set([...reported, ...list("milagre.hiddenRemoteScopes")]), computers);
    },
  };
}

module.exports = { createHiddenChats };
