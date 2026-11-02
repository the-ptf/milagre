// @ts-check
// A Chat on another computer gets Browser pages that draw in this window and reach the web from that computer (#832):
// all of that computer's Chats share one session on this Mac (a sign-in lasts from one Chat to the next, as it does for
// this Mac's Chats), whose proxy is the computer's SOCKS5 proxy on this Mac's host (apps/daemon/src/browser-proxy.cjs).
// Every connection the page makes, localhost included, is opened from the computer over its channel. A page whose
// session has no proxy set is never attached, so it can't fall back to this Mac's network without a word. The proxy is
// set on the session, so a session never spans two computers: this Mac's sign-ins never reach another computer's agents.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { computerOfKey, LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");

const COMPUTER_PARTITION = /^persist:milagre-browser-computer-[a-f0-9]{24}$/;
// Before computers' Chats shared a session, each Chat had its own; their folders are removed on launch.
const CHAT_PARTITION_FOLDER = /^milagre-browser-chat-[a-f0-9]{24}$/;

/** The session a computer's Chats' pages use on this Mac: one per computer, kept across launches. */
const computerPartition = (computerId) => `persist:milagre-browser-computer-${createHash("sha256").update(String(computerId)).digest("hex").slice(0, 24)}`;

/**
 * Removes the per-Chat sessions of the build before (`Partitions/milagre-browser-chat-*` under `userData`). Nothing opens
 * them any more, so their folders go whole, and their sign-ins with them.
 * @param {string} userData
 */
async function removeChatPartitions(userData) {
  const folder = path.join(userData, "Partitions");
  const names = await fs.readdir(folder).catch(() => []);
  await Promise.all(names.filter((name) => CHAT_PARTITION_FOLDER.test(name)).map((name) => fs.rm(path.join(folder, name), { recursive: true, force: true })));
}

/**
 * Signs every page in `session` out of every site: cookies, site storage, HTTP sign-ins and cache go, and its open pages
 * (`guests`) reload signed out.
 * @param {Electron.Session} session
 * @param {Electron.WebContents[]} guests
 */
async function clearSignIns(session, guests) {
  await session.clearStorageData();
  await session.clearAuthCache();
  await session.clearCache();
  await session.closeAllConnections();
  for (const guest of guests) if (!guest.isDestroyed() && guest.session === session) guest.reload();
}

/**
 * @param {{
 *   fromPartition: (partition: string) => Electron.Session;
 *   proxyPort: (computerId: string) => Promise<number>;
 *   harden: (session: Electron.Session) => void;
 * }} options
 */
function createRemoteBrowserSessions({ fromPartition, proxyPort, harden }) {
  /** partition -> the computer whose proxy it uses and that proxy's port, once it is set. */
  const ready = new Map();
  const hardened = new WeakSet();

  /**
   * Points `partition`'s session at `computerId`'s proxy, and drops connections made through an older one. The same
   * proxy again changes nothing: the computer's other Chats' pages keep their connections.
   */
  async function route(partition, computerId) {
    const port = await proxyPort(computerId);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The host gave no proxy for this computer.");
    const routed = ready.get(partition);
    if (routed?.computerId === computerId && routed.port === port) return;
    const session = fromPartition(partition);
    if (!hardened.has(session)) {
      harden(session);
      hardened.add(session);
    }
    // <-loopback> undoes Chromium's implicit bypass: localhost goes to the proxy, and so to the computer.
    await session.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
    await session.closeAllConnections();
    ready.set(partition, { computerId, port });
  }

  return {
    /** Readies the session of `chatKey`'s computer and returns its partition; refuses a Chat on this Mac. */
    async prepare(chatKey) {
      const computerId = typeof chatKey === "string" ? computerOfKey(chatKey) : LOCAL_COMPUTER;
      if (!computerId || computerId === LOCAL_COMPUTER) throw new Error("This Chat's pages open in this Mac's session.");
      const partition = computerPartition(computerId);
      await route(partition, computerId);
      return partition;
    },
    /**
     * Whether a webview may attach in `partition`: this Mac's is checked by the caller; a computer's only once routed.
     * @param {string | undefined} partition
     */
    isReady: (partition) => typeof partition === "string" && COMPUTER_PARTITION.test(partition) && ready.has(partition),
    /** The host started again (its proxies have new ports): every routed session follows. */
    async refresh() {
      await Promise.all(
        [...ready].map(([partition, { computerId }]) =>
          route(partition, computerId).catch((error) => {
            // Until it is routed again, its pages can't attach; open ones fail their next connections.
            ready.delete(partition);
            console.warn("Browser pages for another computer:", error.message);
          }),
        ),
      );
    },
  };
}

module.exports = { clearSignIns, computerPartition, createRemoteBrowserSessions, removeChatPartitions };
