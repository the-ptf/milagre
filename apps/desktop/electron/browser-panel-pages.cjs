// @ts-check
// The Browser panel's pages as the host's browser service sees them: a loopback DevTools endpoint over each page's
// webContents.debugger (@milagre/core/cdp-proxy), and the list of pages with the Chat whose panel shows each, sent to
// the host ("browser:panel-pages"). Another computer's Browser panel and the phone then view and control them like any other Chat
// browser, and the agent's tools reach them the same way.
const { randomBytes } = require("node:crypto");
const { createCdpProxy } = require("@milagre/core/cdp-proxy");

/**
 * @param {{
 *   fromId: (id: number) => Electron.WebContents | undefined;
 *   publish: (request: { port?: number; prefix?: string; pages: { id: string; chatId: string; title: string; url: string }[] }) => Promise<unknown>;
 *   product?: string;
 * }} options
 */
function createBrowserPanelPages({ fromId, publish, product = `Milagre Browser panel (Electron ${process.versions.electron ?? ""})` }) {
  /** @type {Map<number, { pageId: string; chatKey: string; host: Electron.WebContents; users: number; ours: boolean; off: () => void }>} */
  const pages = new Map();
  const live = () =>
    [...pages.entries()].flatMap(([contentsId, page]) => {
      const guest = fromId(contentsId);
      return guest && !guest.isDestroyed() ? [{ contentsId, guest, ...page }] : [];
    });
  const proxy = createCdpProxy({
    product,
    pages: () => live().map(({ pageId, guest }) => ({ id: pageId, title: guest.getTitle(), url: guest.getURL() })),
    session: (pageId) => {
      const found = live().find((page) => page.pageId === pageId);
      if (!found) return null;
      const { guest, contentsId, host } = found;
      const record = /** @type {NonNullable<ReturnType<typeof pages.get>>} */ (pages.get(contentsId));
      const debug = guest.debugger;
      if (!debug.isAttached()) {
        debug.attach("1.3");
        record.ours = true;
      }
      record.users++;
      // A page viewed from the phone or the pill has to keep painting while the panel doesn't show it.
      if (record.users === 1 && !host.isDestroyed()) host.send("browser-panel:viewed", { from: contentsId, viewed: true });
      let released = false;
      return {
        send(method, params, sessionId) {
          // A viewer's size (browsers-cdp.cjs). Emulation would lay the page out at it but leave frames the guest's
          // size, cut where the window ends, so the parked guest takes the size itself (browser-webviews.ts).
          if (!sessionId && (method === "Emulation.setDeviceMetricsOverride" || method === "Emulation.clearDeviceMetricsOverride")) {
            const { width, height } = /** @type {{ width?: unknown; height?: unknown }} */ (params ?? {});
            const viewport =
              method === "Emulation.setDeviceMetricsOverride" && Number.isInteger(width) && Number.isInteger(height)
                ? { width: Number(width), height: Number(height) }
                : null;
            if (!host.isDestroyed()) host.send("browser-panel:viewed", { from: contentsId, viewed: true, viewport });
            return Promise.resolve({});
          }
          // Page.reload through a webview's debugger reloads the window that holds it, Milagre's own, so the guest
          // reloads itself (the agent's browser_navigate reload, a viewer's Reload).
          if (!sessionId && method === "Page.reload") {
            if (guest.isDestroyed()) return Promise.reject(new Error("The page is gone."));
            if (/** @type {{ ignoreCache?: unknown }} */ (params ?? {}).ignoreCache === true) guest.reloadIgnoringCache();
            else guest.reload();
            return Promise.resolve({});
          }
          return debug.sendCommand(method, params, sessionId);
        },
        onEvent(listener) {
          /** @param {unknown} _event @param {string} method @param {unknown} params @param {string} [sessionId] */
          const handler = (_event, method, params, sessionId) => listener(method, params, sessionId);
          debug.on("message", handler);
          return () => debug.removeListener("message", handler);
        },
        release() {
          if (released) return;
          released = true;
          record.users--;
          if (record.users === 0 && !host.isDestroyed()) host.send("browser-panel:viewed", { from: contentsId, viewed: false });
          if (record.users <= 0 && record.ours && !guest.isDestroyed()) {
            record.ours = false;
            try {
              debug.detach();
            } catch {}
          }
        },
      };
    },
  });

  let endpoint = /** @type {Promise<{ port: number; token: string }> | null} */ (null);
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let sent = "";
  /** Sends the host the pages now, soon after the last change, and again whenever forced (a host started again). */
  function schedule(force = false) {
    if (force) sent = "";
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, 250);
  }
  async function send() {
    const list = live().map(({ pageId, chatKey, guest }) => ({
      id: pageId,
      chatId: chatKey,
      title: guest.getTitle().slice(0, 300),
      url: guest.getURL().slice(0, 2048),
    }));
    if (!list.length) {
      if (sent && sent !== "[]") await publish({ pages: [] }).catch(() => {});
      sent = "[]";
      return;
    }
    endpoint ??= proxy.start();
    const { port, token } = await endpoint;
    const request = { port, prefix: `/${token}`, pages: list };
    const key = JSON.stringify(request);
    if (key === sent) return;
    sent = key;
    await publish(request).catch(() => {
      sent = "";
    });
  }

  return {
    /**
     * The renderer's Browser panel pages in `host`: each webview's webContents id and the Chat it belongs to. Only
     * webviews of that window count; the rest are ignored.
     * @param {Electron.WebContents} host
     * @param {unknown} list
     */
    setPages(host, list) {
      const wanted = new Map();
      for (const item of Array.isArray(list) ? list.slice(0, 128) : []) {
        const contentsId = Number(item?.contentsId);
        const chatKey = typeof item?.chatKey === "string" && item.chatKey.length <= 1024 ? item.chatKey : "";
        const guest = Number.isSafeInteger(contentsId) ? fromId(contentsId) : undefined;
        if (!chatKey || !guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== host) continue;
        wanted.set(contentsId, { chatKey, guest });
      }
      for (const [contentsId, page] of pages)
        if (page.host === host && !wanted.has(contentsId)) {
          pages.delete(contentsId);
          page.off();
          proxy.drop(page.pageId);
        }
      for (const [contentsId, { chatKey, guest }] of wanted) {
        const known = pages.get(contentsId);
        if (known) {
          known.chatKey = chatKey;
          continue;
        }
        // The host's list follows the page's title and address; a page that goes takes its DevTools connections with it.
        const changed = () => schedule();
        const destroyed = () => {
          const page = pages.get(contentsId);
          pages.delete(contentsId);
          if (page) proxy.drop(page.pageId);
          schedule();
        };
        const events = /** @type {const} */ (["page-title-updated", "did-navigate", "did-navigate-in-page"]);
        for (const event of events) guest.on(/** @type {any} */ (event), changed);
        guest.once("destroyed", destroyed);
        // Taken off again when the renderer stops listing the page, which may list it again later.
        const off = () => {
          for (const event of events) guest.removeListener(/** @type {any} */ (event), changed);
          guest.removeListener("destroyed", destroyed);
        };
        pages.set(contentsId, { pageId: randomBytes(16).toString("hex").toUpperCase(), chatKey, host, users: 0, ours: false, off });
      }
      schedule();
    },
    /** The host went away and came back: it has none of the pages until they are sent again. */
    republish: () => schedule(true),
    close: () => proxy.close(),
  };
}

module.exports = { createBrowserPanelPages };
