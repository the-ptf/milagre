// @ts-check
// The Browser panel's pages are <webview> guests of the main window. They show any web page, so each is locked down
// before it attaches: no preload, no Node, sandboxed, one sign-in session for every page, and web pages only. A page
// that opens a window gets a new panel tab instead; one that leaves the web (mailto:, an app's own scheme) goes through
// the same external handler as links in replies.
const { webContents } = require("electron");
const { isAppShortcut } = require("./app-shortcuts.cjs");

/** The one persistent session every Browser panel page shares, so signing in once lasts. */
const BROWSER_PARTITION = "persist:milagre-browser";

const PAGE_PROTOCOLS = new Set(["http:", "https:"]);

/** Whether a guest may show this URL: web pages, and the blank page a new tab starts on. */
function isPageUrl(url) {
  if (url === "about:blank") return true;
  try {
    return PAGE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// What a page may ask for. Everything else (camera, microphone, location, notifications, MIDI, USB, HID, serial) is
// refused: a page in the panel is a page the agent is building, not an app the user installed.
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);

// A two-finger swipe sideways goes back or forward, as in Chrome and Safari. Chromium does that by overscroll, which a
// <webview> doesn't get, so each page runs this in a world of its own the page can't see: a sideways trackpad scroll
// that nothing on the page takes, far enough, is a swipe.
const SWIPE_DISTANCE = 120;
// Wheel events further apart than this start a new gesture; momentum keeps them closer.
const SWIPE_GAP_MS = 250;
const SWIPE_WORLD = 1201;

/**
 * Decides, one wheel event at a time, when a gesture is a swipe back or forward. Sent into the page as source.
 * @param {number} distance
 * @param {number} gap
 */
function swipeTracker(distance, gap) {
  let gesture = { dx: 0, dy: 0, at: -Infinity, over: false };
  /** @param {{ dx: number; dy: number; time: number; pageScrolls: boolean }} wheel */
  return ({ dx, dy, time, pageScrolls }) => {
    if (time - gesture.at > gap) gesture = { dx: 0, dy: 0, at: time, over: false };
    gesture.at = time;
    if (gesture.over) return null;
    // Something on the page scrolls sideways: the whole gesture is its, as in Chrome.
    if (pageScrolls) {
      gesture.over = true;
      return null;
    }
    gesture.dx += dx;
    gesture.dy += dy;
    if (Math.abs(gesture.dx) < distance || Math.abs(gesture.dx) < 2 * Math.abs(gesture.dy)) return null;
    gesture.over = true;
    return gesture.dx < 0 ? "back" : "forward";
  };
}

// ponytail: scrollLeft as in left-to-right pages; an RTL page's scroller may swallow or pass a swipe wrongly.
const SWIPE_SCRIPT = `(() => {
  const step = (${swipeTracker})(${SWIPE_DISTANCE}, ${SWIPE_GAP_MS});
  const scrolls = (node, dx) => {
    for (let el = node instanceof Element ? node : null; el; el = el.parentElement) {
      const root = el === document.scrollingElement;
      if (!root && !/auto|scroll|overlay/.test(getComputedStyle(el).overflowX)) continue;
      if (el.scrollWidth <= el.clientWidth) continue;
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
    }
    return false;
  };
  addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.defaultPrevented || event.deltaMode !== 0) return;
    const pageScrolls = Math.abs(event.deltaX) > Math.abs(event.deltaY) && scrolls(event.target, event.deltaX);
    const go = step({ dx: event.deltaX, dy: event.deltaY, time: event.timeStamp, pageScrolls });
    if (go === "back") history.back();
    else if (go === "forward") history.forward();
  }, { passive: true });
})()`;

/** What a page's session may grant: the same few permissions for the shared session and each remote Chat's. */
function hardenBrowserSession(session) {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/**
 * Locks down the window's <webview> guests and wires each page to the window's renderer: a new window becomes a tab
 * ("browser-panel:open-tab"), and the app's shortcuts, ⌘L and ⌘R pressed in a page reach the renderer as if pressed
 * there ("app:shortcut", "browser-panel:key").
 * A page of a Chat on another computer attaches in that Chat's own session, once `remoteReady` says its proxy is set
 * (browser-remote-sessions.cjs); every other page in the shared one.
 * @param {Electron.WebContents} host The main window's webContents.
 * @param {{ session: Electron.Session; openExternal: (url: string) => void; platform?: NodeJS.Platform; remoteReady?: (partition: string | undefined) => boolean }} options
 */
function hardenBrowserGuests(host, { session, openExternal, platform = process.platform, remoteReady = () => false }) {
  hardenBrowserSession(session);
  host.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = params.partition === BROWSER_PARTITION || remoteReady(params.partition) ? params.partition : null;
    if (!partition || !isPageUrl(params.src)) {
      event.preventDefault();
      return;
    }
    // The renderer's webpreferences attribute lands here too: the session is set again, so it can't name another.
    webPreferences.partition = partition;
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
    // Opaque, like a browser tab: a page without a background of its own is white, also in the phone's screencast.
    webPreferences.transparent = false;
  });
  host.on("did-attach-webview", (_event, guest) => guardGuest(host, guest, { openExternal, platform }));
}

/**
 * @param {Electron.WebContents} host
 * @param {Electron.WebContents} guest
 * @param {{ openExternal: (url: string) => void; platform: NodeJS.Platform }} options
 */
function guardGuest(host, guest, { openExternal, platform }) {
  const leave = (url) => {
    if (/^mailto:/i.test(url)) openExternal(url);
  };
  guest.setWindowOpenHandler(({ url }) => {
    if (isPageUrl(url) && url !== "about:blank") host.send("browser-panel:open-tab", { from: guest.id, url });
    else leave(url);
    return { action: "deny" };
  });
  const stay = (event, url) => {
    if (isPageUrl(url)) return;
    event.preventDefault();
    leave(url);
  };
  guest.on("will-navigate", (event, url) => stay(event, url));
  guest.on("will-redirect", (event, url) => stay(event, url));
  // Frames inside the page may load what the web allows (about:srcdoc, data:, blob:), but never a file or app scheme.
  guest.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && /^(file|chrome|devtools|milagre[\w-]*):/i.test(event.url)) event.preventDefault();
  });
  guest.on("dom-ready", () => void guest.executeJavaScriptInIsolatedWorld(SWIPE_WORLD, [{ code: SWIPE_SCRIPT }]).catch(() => {}));
  guest.on("before-input-event", (event, input) => {
    // The keys the window catches from every frame (keybindings.json's forwarded commands), sent on as the window's own.
    if (isAppShortcut(input, platform)) {
      event.preventDefault();
      host.send("app:shortcut", { key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
      return;
    }
    const command = platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    if (input.type !== "keyDown" || !command || input.alt || input.shift) return;
    // ⌘L to the address bar, ⌘R reloads, ⌘W closes the tab: what a browser does with them, not what the window does.
    if (key === "l" || key === "r" || key === "w") {
      event.preventDefault();
      host.send("browser-panel:key", { from: guest.id, key });
    }
  });
}

/**
 * A PNG of part of one of `host`'s own pages (a picked element, for a page comment), at most 800 pixels wide; null for
 * another window's page or any other webContents.
 * @param {Electron.WebContents} host
 * @param {unknown} contentsId
 * @param {unknown} rect
 */
async function captureBrowserPage(host, contentsId, rect) {
  const guest = Number.isSafeInteger(contentsId) ? webContents.fromId(/** @type {number} */ (contentsId)) : undefined;
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview" || guest.hostWebContents !== host) return null;
  const area = /** @type {Record<string, unknown>} */ (rect && typeof rect === "object" ? rect : {});
  const x = Math.round(Number(area.x)),
    y = Math.round(Number(area.y)),
    width = Math.round(Number(area.width)),
    height = Math.round(Number(area.height));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  const image = await guest.capturePage({ x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, 4000), height: Math.min(height, 4000) });
  if (image.isEmpty()) return null;
  return (image.getSize().width > 800 ? image.resize({ width: 800 }) : image).toDataURL();
}

module.exports = { BROWSER_PARTITION, captureBrowserPage, hardenBrowserGuests, hardenBrowserSession, isPageUrl, swipeTracker };
