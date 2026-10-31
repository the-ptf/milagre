// @ts-check
// A Chat on another computer gets Browser pages that draw in this window and reach the web from that computer (#832):
// each such Chat has a session of its own (its sign-ins stay its own), whose proxy is the computer's SOCKS5 proxy on this
// Mac's host (apps/daemon/src/browser-proxy.cjs). Every connection the page makes, localhost included, is opened from the
// computer over its channel. A page whose session has no proxy set is never attached, so it can't fall back to this
// Mac's network without a word.
const { createHash } = require("node:crypto");
const { computerOfKey, LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");

const CHAT_PARTITION = /^persist:milagre-browser-chat-[a-f0-9]{24}$/;

/** The session a remote Chat's pages use: one per Chat, kept across launches. */
const chatPartition = (chatKey) => `persist:milagre-browser-chat-${createHash("sha256").update(String(chatKey)).digest("hex").slice(0, 24)}`;

/**
 * @param {{
 *   fromPartition: (partition: string) => Electron.Session;
 *   proxyPort: (computerId: string) => Promise<number>;
 *   harden: (session: Electron.Session) => void;
 * }} options
 */
function createRemoteBrowserSessions({ fromPartition, proxyPort, harden }) {
  /** partition -> the computer whose proxy it uses, once that proxy is set. */
  const ready = new Map();
  const hardened = new WeakSet();

  /** Points `partition`'s session at `computerId`'s proxy, and drops connections made through an older one. */
  async function route(partition, computerId) {
    const port = await proxyPort(computerId);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The host gave no proxy for this computer.");
    const session = fromPartition(partition);
    if (!hardened.has(session)) {
      harden(session);
      hardened.add(session);
    }
    // <-loopback> undoes Chromium's implicit bypass: localhost goes to the proxy, and so to the computer.
    await session.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: "<-loopback>" });
    await session.closeAllConnections();
    ready.set(partition, computerId);
  }

  return {
    /** Readies `chatKey`'s session for its computer and returns its partition; refuses a Chat on this Mac. */
    async prepare(chatKey) {
      const computerId = typeof chatKey === "string" ? computerOfKey(chatKey) : LOCAL_COMPUTER;
      if (!computerId || computerId === LOCAL_COMPUTER) throw new Error("This Chat's pages open in the shared session.");
      const partition = chatPartition(chatKey);
      await route(partition, computerId);
      return partition;
    },
    /**
     * Whether a webview may attach in `partition`: the shared one is checked by the caller; a Chat's only once routed.
     * @param {string | undefined} partition
     */
    isReady: (partition) => typeof partition === "string" && CHAT_PARTITION.test(partition) && ready.has(partition),
    /** The host started again (its proxies have new ports): every routed session follows. */
    async refresh() {
      await Promise.all(
        [...ready].map(([partition, computerId]) =>
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

module.exports = { createRemoteBrowserSessions, chatPartition };
