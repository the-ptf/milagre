import type { WebviewTag } from "electron";
import { PAGE_PICK_CANCEL, pagePickScript, pagePinsHidden, pagePinsScript, type PagePin } from "@milagre/shared/page-picker";
import type { PageElement } from "@milagre/shared/page-comments";
import { ipcErrorMessage } from "@milagre/shared/result";
import { isRemoteKey } from "./computer-bridge";
import { changedThisLaunch, chatBrowser, closeBrowserTab, openBrowserTab, patchBrowserTab, takeNavigation, type ChatBrowser } from "./browser-panel.ts";

/**
 * The Browser panels' pages: one <webview> per tab, made once and never moved. A webview moved in the document, or
 * taken out of it, loses its page, so every page lives in one fixed layer on <body> that no Chat switch, Link or view
 * change touches. The page on screen is laid over its panel's slot; the others are parked off screen at their last
 * size and keep running. Only the pages shown most recently stay alive; an older one is closed and loads again when it
 * shows.
 *
 * The layer sits above the app's docked panels (z-10 for the whole dock layer) and below what the app portals to the
 * body (menus, tooltips, dialogs at z-50), so those still open over a page.
 */
const LIVE_PAGES = 8;
const LAYER_Z = "11";

type Page = {
  chatKey: string;
  tabId: string;
  surface: HTMLDivElement;
  webview: WebviewTag;
  /** Over the page, inside its surface: what the panel draws on the page (a comment being written). */
  overlay: HTMLDivElement;
  contentsId: number | null;
  shownAt: number;
  /** The comment pins this page shows, put back after every load. */
  pins: PagePin[];
  /** Viewed from the phone or another computer: parked where it still paints. */
  viewed: boolean;
  /** The viewer's size, which the page takes while parked and viewed; null keeps the size it had. */
  viewport: { width: number; height: number } | null;
};

const pages = new Map<string, Page>();
let layer: HTMLDivElement | null = null;
/** The page on screen, the slot it is laid over, and the bottom corners' radius of the panel's card it rounds to. */
let shown: { tabId: string; slot: HTMLElement; radius: number } | null = null;

function ensureLayer() {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.dataset.browserPages = "";
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: LAYER_Z, pointerEvents: "none", overflow: "hidden" });
  document.body.append(layer);
  return layer;
}

const PARKED = { left: "-100000px", top: "0px" };

function createPage(chatKey: string, tabId: string, address: string): Page {
  // An address typed before the page existed is the one it opens on.
  const url = takeNavigation(tabId) ?? address;
  const surface = document.createElement("div");
  surface.dataset.browserPage = tabId;
  Object.assign(surface.style, { position: "absolute", width: "1280px", height: "800px", ...PARKED, pointerEvents: "none" });
  const webview = document.createElement("webview") as WebviewTag;
  // A Chat on another computer opens its pages in a session of its own that reaches the web from that computer (#832);
  // the webview joins the page once main has routed it, below.
  const remote = isRemoteKey(chatKey);
  if (!remote) webview.setAttribute("partition", window.milagreBrowserPanel?.partition ?? "persist:milagre-browser");
  webview.setAttribute("allowpopups", "");
  webview.setAttribute("webpreferences", "disableHtmlFullscreenWindowResize=true");
  if (!remote) webview.setAttribute("src", url);
  Object.assign(webview.style, { width: "100%", height: "100%", display: "flex", background: "white" });
  const overlay = document.createElement("div");
  overlay.dataset.browserOverlay = tabId;
  Object.assign(overlay.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  const page: Page = { chatKey, tabId, surface, webview, overlay, contentsId: null, shownAt: 0, pins: [], viewed: false, viewport: null };
  const history = () => ({ canGoBack: safe(() => webview.canGoBack(), false), canGoForward: safe(() => webview.canGoForward(), false) });
  webview.addEventListener("dom-ready", () => {
    const before = page.contentsId;
    page.contentsId = safe(() => webview.getWebContentsId(), null);
    if (page.contentsId !== before) reportPages();
    const typed = takeNavigation(tabId);
    if (typed) void call(page, (webview) => webview.loadURL(typed));
    // A new document starts without pins.
    pinned.delete(page);
    applyPins(page);
  });
  webview.addEventListener("did-start-loading", () => patchBrowserTab(chatKey, tabId, { loading: true, error: undefined }));
  webview.addEventListener("did-stop-loading", () => patchBrowserTab(chatKey, tabId, { loading: false, ...history() }));
  webview.addEventListener("did-navigate", (event) => patchBrowserTab(chatKey, tabId, { url: event.url, ...history() }));
  webview.addEventListener("did-navigate-in-page", (event) => {
    if (!event.isMainFrame) return;
    patchBrowserTab(chatKey, tabId, { url: event.url, ...history() });
    applyPins(page);
  });
  webview.addEventListener("page-title-updated", (event) => patchBrowserTab(chatKey, tabId, { title: event.title }));
  webview.addEventListener("page-favicon-updated", (event) => {
    const favicon = event.favicons[0];
    // The tab's <img> would fetch it from this Mac; a remote Chat's page reads it through its computer instead (#832).
    if (!remote || !favicon) return patchBrowserTab(chatKey, tabId, { favicon });
    void call(page, (webview) => webview.executeJavaScript(faviconScript(favicon))).then((data) => {
      if (typeof data === "string" && data.startsWith("data:image/")) patchBrowserTab(chatKey, tabId, { favicon: data });
    });
  });
  webview.addEventListener("did-fail-load", (event) => {
    // -3 is a load the next one replaced (a redirect, a new address typed).
    if (!event.isMainFrame || event.errorCode === -3) return;
    patchBrowserTab(chatKey, tabId, { loading: false, error: loadError(event.errorCode, event.errorDescription, event.validatedURL, remote) });
  });
  webview.addEventListener("render-process-gone", () =>
    patchBrowserTab(chatKey, tabId, { loading: false, error: "The page stopped responding. Reload to try again." }),
  );
  surface.append(...(remote ? [overlay] : [webview, overlay]));
  ensureLayer().append(surface);
  pages.set(tabId, page);
  if (remote) void attachRemote(page, url);
  return page;
}

/**
 * Joins a remote Chat's webview to its page once its session goes through its computer. While the computer can't be
 * reached the page goes and the tab says why; Try again makes a new one.
 */
async function attachRemote(page: Page, url: string) {
  const { chatKey, tabId, webview, surface, overlay } = page;
  patchBrowserTab(chatKey, tabId, { loading: true, error: undefined });
  try {
    const prepare = window.milagreBrowserPanel?.remotePartition;
    if (!prepare) throw new Error("This Milagre can't open another computer's pages here. Update it, then try again.");
    const partition = await prepare(chatKey);
    if (pages.get(tabId) !== page) return;
    webview.setAttribute("partition", partition);
    webview.setAttribute("src", takeNavigation(tabId) ?? url);
    surface.insertBefore(webview, overlay);
  } catch (error) {
    if (pages.get(tabId) !== page) return;
    destroyPage(page);
    patchBrowserTab(chatKey, tabId, { loading: false, error: `This page goes through its computer, which can't be reached: ${ipcErrorMessage(error)}` });
  }
}

/** Run in a page: its favicon as a data URL, fetched by the page itself (so through its session), or null past 64 KB. */
const faviconScript = (url: string) =>
  `fetch(${JSON.stringify(url)}).then((r) => (r.ok ? r.blob() : null)).then((b) => !b || b.size > 65536 || !b.type.startsWith("image/") ? null : new Promise((done) => { const f = new FileReader(); f.onload = () => done(f.result); f.onerror = () => done(null); f.readAsDataURL(b); })).catch(() => null)`;

function loadError(code: number, description: string, url: string, remote = false) {
  // The usual one: the Chat's dev server isn't running (yet).
  if (code === -102) return `Nothing is answering at ${hostOf(url)}. Is the server running?`;
  // A remote Chat's page reaches the web from its computer (#832); Chromium names every way that fails this one code.
  if (remote && code === -120) return `Its computer couldn't reach ${hostOf(url)}. Is the server running there?`;
  if (code === -105) return `${hostOf(url)} could not be found.`;
  return `The page didn't load (${description || code}).`;
}

const hostOf = (url: string) => safe(() => new URL(url).host, url);

/**
 * Runs a webview method that needs the page attached and ready. A page taken out of the document (its tab closed while
 * a pick was waiting) throws at once instead of rejecting, which in an effect's cleanup would take the window down.
 */
async function call<T>(page: Page, run: (webview: WebviewTag) => Promise<T>): Promise<T | undefined> {
  try {
    if (!page.webview.isConnected || !page.contentsId) return undefined;
    return await run(page.webview);
  } catch {
    return undefined;
  }
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function destroyPage(page: Page) {
  page.surface.remove();
  pages.delete(page.tabId);
  reportPages();
}

/** Tells main which webview is which Chat's, so the host can serve the pages to the pill, the phone and the agent. */
function reportPages() {
  const list = [...pages.values()].flatMap((page) => (page.contentsId ? [{ contentsId: page.contentsId, chatKey: page.chatKey }] : []));
  void window.milagreBrowserPanel?.setPages?.(list).catch(() => {});
}

/** The webview of a tab, if its page is alive. */
export const browserWebview = (tabId: string): WebviewTag | null => pages.get(tabId)?.webview ?? null;

/** Brings every Chat's pages in line with its tabs: new tabs get a page, closed ones lose theirs, typed addresses load. */
export function syncBrowserPages(chats: ReadonlyMap<string, ChatBrowser>) {
  const wanted = new Set<string>();
  for (const [chatKey, chat] of chats)
    for (const tab of chat.tabs) {
      wanted.add(tab.id);
      const page = pages.get(tab.id);
      // Before its first load a page can't navigate; it takes the address when it is ready.
      const url = page?.contentsId ? takeNavigation(tab.id) : undefined;
      if (page && url) void call(page, (webview) => webview.loadURL(url));
      // A tab gets its page the first time it shows, or when something opens it now (the agent's browser_open, a link)
      // in a Chat that isn't on screen; a tab remembered from the last launch stays a URL until its panel shows.
      else if (!page && chat.open && chat.active === tab.id && tab.url !== "about:blank" && !tab.error && changedThisLaunch(chatKey))
        createPage(chatKey, tab.id, tab.url);
    }
  for (const page of pages.values()) if (!wanted.has(page.tabId)) destroyPage(page);
}

/**
 * Takes a page off screen. One viewed from the phone or the pill stays in the window at its size instead, invisible
 * and letting clicks through: off screen, Chromium stops painting it and the viewer would get no frames.
 */
function park(page: Page) {
  if (page.viewed) {
    // Only what is inside the window paints, so a viewer bigger than this window gets the window's size.
    const size = page.viewport
      ? { width: `${Math.min(page.viewport.width, window.innerWidth)}px`, height: `${Math.min(page.viewport.height, window.innerHeight)}px` }
      : {};
    Object.assign(page.surface.style, { left: "0px", top: "0px", ...size, opacity: "0", pointerEvents: "none", clipPath: "" });
  } else Object.assign(page.surface.style, PARKED, { opacity: "1", pointerEvents: "none", clipPath: "" });
}

function place() {
  if (!shown) return;
  const page = pages.get(shown.tabId);
  if (!page) return;
  const rect = shown.slot.isConnected ? shown.slot.getBoundingClientRect() : null;
  // The panel is out of the document (another view, a Link) or not laid out yet: the page waits off screen.
  if (!rect || rect.width < 2 || rect.height < 2) {
    park(page);
    return;
  }
  const style = page.surface.style;
  const next = { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` };
  if (style.left !== next.left || style.top !== next.top || style.width !== next.width || style.height !== next.height) Object.assign(style, next);
  style.opacity = "1";
  style.pointerEvents = "auto";
  // The page is outside the panel's card, so the card's clip misses it: it is cut at the dock's edges (sliding open or
  // closed it would draw over the changes panel beside it) and takes the card's bottom corners.
  const dock = shown.slot.closest("[data-slot=browser-dock]")?.getBoundingClientRect();
  const cut = dock ? [Math.max(0, rect.right - dock.right), Math.max(0, dock.left - rect.left)] : [0, 0];
  const clip = `inset(0 ${cut[0]}px 0 ${cut[1]}px round 0 0 ${shown.radius}px ${shown.radius}px)`;
  if (style.clipPath !== clip) style.clipPath = clip;
}

// After anything that can move the slot (the panel springing open, a drag, the changes panel opening beside it), the
// page follows it for a moment each frame; at rest nothing runs but a slow check that the panel is still on screen.
let settleUntil = 0;
let frame = 0;
function settle() {
  settleUntil = performance.now() + 600;
  if (frame) return;
  const tick = () => {
    place();
    frame = performance.now() < settleUntil ? requestAnimationFrame(tick) : 0;
  };
  frame = requestAnimationFrame(tick);
}

/**
 * Lays tab `tabId`'s page over `slot` until the returned function runs, which parks it again. The page is made if it
 * isn't alive; the least recently shown pages beyond LIVE_PAGES close.
 */
export function showBrowserPage(chatKey: string, tabId: string, slot: HTMLElement): () => void {
  const tab = chatBrowser(chatKey).tabs.find((item) => item.id === tabId);
  const page = pages.get(tabId) ?? (tab ? createPage(chatKey, tabId, tab.url) : null);
  if (!page) return () => {};
  page.shownAt = performance.now();
  for (const old of [...pages.values()].toSorted((a, b) => b.shownAt - a.shownAt).slice(LIVE_PAGES)) if (old !== page) destroyPage(old);
  // The slot is the card's last child, so its bottom corners are the card's.
  const radius = slot.parentElement ? parseFloat(getComputedStyle(slot.parentElement).borderBottomRightRadius) || 0 : 0;
  shown = { tabId, slot, radius };
  place();
  settle();
  const resize = new ResizeObserver(settle);
  resize.observe(slot);
  // The docked panel moves by its style (`right`) when a panel right of it opens; its size alone wouldn't say so.
  const moves = new MutationObserver(settle);
  const dock = slot.closest<HTMLElement>("[data-slot=browser-dock]");
  if (dock) moves.observe(dock, { attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", settle);
  const check = window.setInterval(place, 400);
  return () => {
    resize.disconnect();
    moves.disconnect();
    window.removeEventListener("resize", settle);
    window.clearInterval(check);
    if (shown?.tabId === tabId) shown = null;
    const current = pages.get(tabId);
    if (current) park(current);
  };
}

/** Focuses the page on screen, so typing goes to it. */
export function focusBrowserPage(tabId: string) {
  pages.get(tabId)?.webview.focus();
}

const pageOfContents = (contentsId: number) => [...pages.values()].find((page) => page.contentsId === contentsId);

/** Main's events about pages: a page asking for a new window gets a tab beside it; ⌘L, ⌘R and ⌘W pressed in a page. */
export function listenToBrowserPages(onKey: (chatKey: string, tabId: string, key: "l" | "r" | "w") => void): () => void {
  const bridge = window.milagreBrowserPanel;
  if (!bridge) return () => {};
  const offTab = bridge.onOpenTab(({ from, url }) => {
    const page = pageOfContents(from);
    if (page) openBrowserTab(page.chatKey, url);
  });
  const offKey = bridge.onKey(({ from, key }) => {
    const sender = pageOfContents(from);
    if (!sender) return;
    // A page keeps the keyboard after another tab shows, so the key is for the tab on screen, not the one that sent it.
    const tabId = chatBrowser(sender.chatKey).active ?? sender.tabId;
    if (key === "r") safe(() => pages.get(tabId)?.webview.reload(), undefined);
    else if (key === "w") closeBrowserTab(sender.chatKey, tabId);
    else onKey(sender.chatKey, tabId, key);
  });
  const offOpen = bridge.onOpenUrl?.(({ chatKey, url }) => {
    if (typeof chatKey === "string" && /^https?:\/\//i.test(url)) openBrowserTab(chatKey, url);
  });
  const offViewed = bridge.onViewed?.(({ from, viewed, viewport }) => {
    const page = pageOfContents(from);
    if (!page) return;
    page.viewed = viewed;
    if (!viewed) page.viewport = null;
    else if (viewport !== undefined) page.viewport = viewport;
    if (shown?.tabId !== page.tabId) park(page);
  });
  return () => {
    offTab();
    offKey();
    offViewed?.();
    offOpen?.();
  };
}

/** Where the panel draws over a tab's page (the comment box), or null while the page isn't alive. */
export const browserOverlay = (tabId: string): HTMLDivElement | null => pages.get(tabId)?.overlay ?? null;

const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#007df3";
const green = () => getComputedStyle(document.documentElement).getPropertyValue("--green").trim() || "#199a4d";

// Pages whose current document has pins: an empty list then has to take them away; otherwise it needs no script.
const pinned = new WeakSet<Page>();
function applyPins(page: Page) {
  if (!page.pins.length && !pinned.has(page)) return;
  if (page.pins.length) pinned.add(page);
  else pinned.delete(page);
  void call(page, (webview) => webview.executeJavaScript(pagePinsScript(page.pins, { accent: accent(), green: green() })));
}

/** Shows `pins` on a tab's page now and after every load. */
export function setPagePins(tabId: string, pins: PagePin[]) {
  const page = pages.get(tabId);
  if (!page || JSON.stringify(page.pins) === JSON.stringify(pins)) return;
  page.pins = pins;
  if (page.contentsId) applyPins(page);
}

/**
 * Lets the user pick an element on a tab's page: resolves to it; null when they press Escape, the page navigates or
 * cancelPagePick runs; undefined when a newer pick replaced this one. The page is focused so its keys reach the picker.
 */
export async function pickOnPage(tabId: string): Promise<PageElement | null | undefined> {
  const page = pages.get(tabId);
  if (!page) return null;
  page.webview.focus();
  const picked = await call(page, (webview) => webview.executeJavaScript(pagePickScript(accent()), true).then((value) => ({ value })));
  return picked ? (picked.value as PageElement | null | undefined) : null;
}

export function cancelPagePick(tabId: string) {
  const page = pages.get(tabId);
  if (page) void call(page, (webview) => webview.executeJavaScript(PAGE_PICK_CANCEL));
}

/** A PNG of an element's box on a tab's page (with a margin, without the pins), or null. */
export async function capturePageElement(tabId: string, box: PageElement["box"]): Promise<string | null> {
  const page = pages.get(tabId);
  const capture = window.milagreBrowserPanel?.capture;
  if (!page?.contentsId || !capture) return null;
  const margin = 12;
  const contentsId = page.contentsId;
  try {
    // Two of the page's own frames, so its last painted frame has neither the pins nor the picker's label.
    await call(page, (webview) =>
      webview.executeJavaScript(`${pagePinsHidden(true)}; new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`),
    );
    return await capture(contentsId, { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 });
  } catch {
    return null;
  } finally {
    void call(page, (webview) => webview.executeJavaScript(pagePinsHidden(false)));
  }
}
