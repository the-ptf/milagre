// @ts-check
const { connect } = require("@milagre/daemon/client");

// A call to a paired computer holds its daemon request until the computer answers over the LAN or the relay: one remote
// Chat's images (a media:read each, 60-300 ms over the relay) held 21-28 of the window's 32 slots (MAX_PENDING) at once,
// and a Chat switch on this Mac queued its chat:messages behind them. Those calls get a daemon connection of their own:
// the daemon gives each connection its own slots, and still holds each one to the limit.
const METHODS = new Set(["computers:invoke"]);
// A lane that couldn't open is not tried again for this long; its calls go over the window's connection meanwhile.
const RETRY_MS = 10_000;
const OPEN_TIMEOUT_MS = 2_000;
const CHAT_PAGES = "chat-pages-v1";
const STATE_PATCHES = "state-patches-v1";
const SUBAGENT_TAILS = "subagent-tails-v1";
const ARCHIVED_SUMMARIES = "archived-subagent-summaries-v1";

/**
 * The daemon sends each connection every event, in the form it asked for. The lane asks for the window's own form (as
 * runtime-client.cjs takeStatePatches does), so the daemon encodes nothing more for it; the lane drops them unread.
 * @param {string[]} capabilities
 */
function eventForm(capabilities) {
  if (capabilities.includes(CHAT_PAGES)) {
    const tails = capabilities.includes(SUBAGENT_TAILS);
    return [
      {
        messages: false,
        ...(tails ? { transcripts: false } : {}),
        ...(tails && capabilities.includes(ARCHIVED_SUMMARIES) ? { archivedSubagents: false } : {}),
      },
    ];
  }
  return capabilities.includes(STATE_PATCHES) ? [] : null;
}

/**
 * The connection main sends paired computers' calls on (`handles(method)`). While the window's runtime is connected
 * (`available()`), a call opens the lane if needed; a lane that can't open, or a host that can't take one, sends it
 * over the window's connection instead (`fallback`), as before.
 * @param {{
 *   dataDir: string;
 *   available: () => boolean;
 *   fallback: (method: string, args: unknown[]) => Promise<any>;
 *   connect?: typeof connect;
 *   now?: () => number;
 * }} options
 */
function createComputersLane({ dataDir, available, fallback, connect: open = connect, now = Date.now }) {
  /** @type {Awaited<ReturnType<typeof connect>> | null} */
  let client = null;
  /** @type {Promise<Awaited<ReturnType<typeof connect>> | null> | null} */
  let opening = null;
  let closed = false;
  // When the last lane failed to open; calls take the window's connection until RETRY_MS later.
  let failedAt = -Infinity;

  async function openLane() {
    let next;
    try {
      next = await open({ dataDir, timeoutMs: OPEN_TIMEOUT_MS, events: false });
    } catch {
      failedAt = now();
      return null;
    }
    try {
      const status = await next.call("daemon:status");
      const capabilities = Array.isArray(status?.capabilities) ? status.capabilities : [];
      if (!capabilities.includes("computer-management-v1")) throw new Error("This host has no computer commands");
      const form = eventForm(capabilities);
      if (form) await next.call("daemon:state-patches", form);
    } catch {
      next.close();
      failedAt = now();
      return null;
    }
    if (closed) {
      next.close();
      return null;
    }
    const lane = next;
    lane.once("close", () => {
      if (client === lane) client = null;
    });
    client = lane;
    return lane;
  }

  return {
    /** @param {string} method */
    handles: (method) => METHODS.has(method),
    /** @param {string} method @param {unknown[]} [args] */
    async invoke(method, args = []) {
      if (closed || !available()) return fallback(method, args);
      let lane = client;
      if (!lane) {
        if (now() - failedAt < RETRY_MS) return fallback(method, args);
        opening ??= openLane().finally(() => {
          opening = null;
        });
        lane = await opening;
      }
      // A lane that closed before the call went out (its host stopped) sends nothing: the window's connection decides.
      if (!lane || lane !== client || closed || !available()) return fallback(method, args);
      return lane.call(method, args);
    },
    /** The host was started again: it may take a lane now. */
    reset() {
      failedAt = -Infinity;
    },
    close() {
      closed = true;
      client?.close();
      client = null;
    },
  };
}

module.exports = { createComputersLane };
