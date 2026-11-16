// @ts-check
const { connect } = require("@milagre/daemon/client");

const METHODS = new Set(["computers:invoke"]);
const RETRY_MS = 10_000;
const OPEN_TIMEOUT_MS = 2_000;
const CHAT_PAGES = "chat-pages-v1";
const STATE_PATCHES = "state-patches-v1";
const SUBAGENT_TAILS = "subagent-tails-v1";
const ARCHIVED_SUMMARIES = "archived-subagent-summaries-v1";

/**
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
      if (!lane || lane !== client || closed || !available()) return fallback(method, args);
      return lane.call(method, args);
    },
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
