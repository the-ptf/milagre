// @ts-check
const { hiddenHere } = require("@milagre/shared/attention");

const NONE = new Set();
// Kept by the window in preferences (lib/hidden-projects.ts, lib/settings.ts).
const HIDDEN_KEYS = new Set(["milagre.hiddenRemoteScopes", "milagre.hiddenComputers", "milagre-settings"]);
// This Mac's hidden Projects as last known (the host keeps them): saved, so a restart is quiet before the host answers.
const LOCAL_KEY = "milagre.hiddenLocalProjects";

/**
 * Which Chats this Mac's sidebar leaves out, for the notifier: a paired computer's Project hidden here, a computer
 * unchecked in Filters › Computers (while Other computers is on), and this Mac's hidden Projects as the host or the
 * window last reported them (the host keeps that list). All read from preferences, so they hold from launch, before the
 * host connects or the window loads.
 * @param {{ get(key: string): string | null | undefined; set(key: string, value: string | null): void }} preferences
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
  return {
    /** This Mac's hidden Projects, from the host or the window. Saved only when they change. @param {unknown} paths */
    setReported(paths) {
      const next = Array.isArray(paths) ? [...new Set(paths.filter((item) => typeof item === "string" && item.length > 0))].sort() : [];
      const value = next.length ? JSON.stringify(next) : null;
      if ((preferences.get(LOCAL_KEY) ?? null) === value) return false;
      try {
        preferences.set(LOCAL_KEY, value);
      } catch (error) {
        console.warn("Hidden Projects:", error instanceof Error ? error.message : String(error));
        return false;
      }
      return true;
    },
    /** @param {string} key */
    affects: (key) => HIDDEN_KEYS.has(key),
    /** @param {string} chatId */
    isHidden(chatId) {
      const settings = /** @type {{ otherComputers?: unknown } | null} */ (read("milagre-settings"));
      const computers = settings?.otherComputers === true ? new Set(list("milagre.hiddenComputers")) : NONE;
      return hiddenHere(chatId, new Set([...list(LOCAL_KEY), ...list("milagre.hiddenRemoteScopes")]), computers);
    },
  };
}

module.exports = { createHiddenChats };
