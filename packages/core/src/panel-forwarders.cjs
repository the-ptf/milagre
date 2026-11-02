const net = require("node:net");

// A paired desktop's Browser pages for Chats on this host (#832): they draw in that desktop's window, and this host's
// browser service (agent tools, the phone's viewer, comments) reaches them through the desktop's DevTools proxy. That
// proxy is on the desktop's loopback, so this host opens a loopback listener per desktop and carries each connection to
// it as a stream back over the desktop's channel (peer-streams.cjs). browsers-cdp.cjs then connects as to any panel.

/** One loopback forwarder per desktop connection (`owner`), to `port` on that desktop's loopback. */
function createPanelForwarders() {
  /** @type {Map<string, Promise<{ server: net.Server; port: number; target: number; sockets: Set<net.Socket>; open: (target: string, port: number) => Promise<import("node:stream").Duplex> }>>} */
  const forwarders = new Map();

  function start(target, open) {
    return new Promise((resolve, reject) => {
      const sockets = new Set();
      const entry = { server: /** @type {net.Server} */ (/** @type {unknown} */ (null)), port: 0, target, sockets, open };
      entry.server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.pause();
        entry.open("127.0.0.1", target).then(
          (stream) => {
            if (socket.destroyed) return stream.destroy();
            stream.on("error", () => socket.destroy());
            stream.on("close", () => socket.destroy());
            socket.on("close", () => stream.destroy());
            socket.pipe(stream).pipe(socket);
            socket.resume();
          },
          () => socket.destroy(),
        );
      });
      entry.server.once("error", reject);
      entry.server.listen(0, "127.0.0.1", () => {
        entry.port = /** @type {net.AddressInfo} */ (entry.server.address()).port;
        resolve(entry);
      });
    });
  }

  async function close(owner) {
    const forwarder = forwarders.get(owner);
    forwarders.delete(owner);
    const running = await forwarder?.catch(() => null);
    if (!running) return;
    for (const socket of running.sockets) socket.destroy();
    await new Promise((resolve) => running.server.close(() => resolve(undefined)));
  }

  return {
    /** The loopback port that reaches `target` on `owner`'s desktop, through `open`; one listener per desktop. */
    async forward(owner, open, target) {
      if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error("Invalid Browser panel endpoint.");
      const current = await forwarders.get(owner)?.catch(() => null);
      if (current && current.target === target) {
        current.open = open;
        return current.port;
      }
      if (current) await close(owner);
      const next = start(target, open);
      forwarders.set(owner, next);
      next.catch(() => forwarders.delete(owner));
      return (await next).port;
    },
    close,
    async closeAll() {
      await Promise.all([...forwarders.keys()].map((owner) => close(owner)));
    },
  };
}

module.exports = { createPanelForwarders };
