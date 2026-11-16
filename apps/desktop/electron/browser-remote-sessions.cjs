// @ts-check
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { computerOfKey, LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");

const COMPUTER_PARTITION = /^persist:milagre-browser-computer-[a-f0-9]{24}$/;
const CHAT_PARTITION_FOLDER = /^milagre-browser-chat-[a-f0-9]{24}$/;

const computerPartition = (computerId) => `persist:milagre-browser-computer-${createHash("sha256").update(String(computerId)).digest("hex").slice(0, 24)}`;

/**
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
  const ready = new Map();
  const hardened = new WeakSet();

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
    async prepare(chatKey) {
      const computerId = typeof chatKey === "string" ? computerOfKey(chatKey) : LOCAL_COMPUTER;
      if (!computerId || computerId === LOCAL_COMPUTER) throw new Error("This Chat's pages open in this Mac's session.");
      const partition = computerPartition(computerId);
      await route(partition, computerId);
      return partition;
    },
    /**
     * @param {string | undefined} partition
     */
    isReady: (partition) => typeof partition === "string" && COMPUTER_PARTITION.test(partition) && ready.has(partition),
    async refresh() {
      await Promise.all(
        [...ready].map(([partition, { computerId }]) =>
          route(partition, computerId).catch((error) => {
            ready.delete(partition);
            console.warn("Browser pages for another computer:", error.message);
          }),
        ),
      );
    },
  };
}

module.exports = { clearSignIns, computerPartition, createRemoteBrowserSessions, removeChatPartitions };
