import { useSyncExternalStore } from "react";
import { preferenceStorage as localStorage } from "./preference-storage.ts";

/** One page in a Chat's Browser panel. The page itself is a <webview> in browser-webviews.ts, keyed by `id`. */
export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Why the page didn't load, until the next load starts. */
  error?: string;
};

/** A Chat's Browser panel: whether it shows, its tabs, and the one on screen. */
export type ChatBrowser = { open: boolean; tabs: BrowserTab[]; active: string | null };

const EMPTY: ChatBrowser = { open: false, tabs: [], active: null };
const STORAGE_KEY = "milagre.browserPanel";
// Chats whose tabs are remembered across restarts, newest first; older ones start empty.
const REMEMBERED_CHATS = 40;

let chats = new Map<string, ChatBrowser>(load());
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function load(): [string, ChatBrowser][] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as [
      string,
      { open?: boolean; tabs?: { id: string; url: string; title?: string }[]; active?: string },
    ][];
    return saved.flatMap(([chat, value]) => {
      const tabs = (value.tabs ?? [])
        .filter((tab) => typeof tab?.id === "string" && typeof tab.url === "string")
        .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title ?? "", loading: false, canGoBack: false, canGoForward: false }));
      if (!tabs.length) return [];
      const active = tabs.some((tab) => tab.id === value.active) ? value.active! : tabs[0]!.id;
      return [[chat, { open: value.open === true, tabs, active }] as [string, ChatBrowser]];
    });
  } catch {
    return [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const kept = [...chats].filter(([, chat]) => chat.tabs.length).slice(-REMEMBERED_CHATS);
    // Tabs not remembered are a lost convenience, not an error to show.
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(kept.map(([chat, { open, tabs, active }]) => [chat, { open, active, tabs: tabs.map(({ id, url, title }) => ({ id, url, title })) }])),
      );
    } catch {}
  }, 300);
}

// Chats whose tabs changed since the app started: the remembered rest wait for their panel before loading a page.
const changed = new Set<string>();
export const changedThisLaunch = (chatKey: string) => changed.has(chatKey);

function update(chatKey: string, change: (chat: ChatBrowser) => ChatBrowser) {
  const before = chats.get(chatKey) ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  changed.add(chatKey);
  // The most recently changed Chat goes last, so the remembered ones are the newest.
  const next = new Map(chats);
  next.delete(chatKey);
  next.set(chatKey, after);
  chats = next;
  save();
  for (const listener of listeners) listener();
}

/** A Chat's Browser panel, re-rendering when it changes. */
export function useChatBrowser(chatKey: string | null): ChatBrowser {
  return useSyncExternalStore(subscribe, () => (chatKey ? (chats.get(chatKey) ?? EMPTY) : EMPTY));
}

/** Every Chat's Browser panel, for the layer that keeps their pages alive. */
export function useAllChatBrowsers(): ReadonlyMap<string, ChatBrowser> {
  return useSyncExternalStore(subscribe, () => chats);
}

export const chatBrowser = (chatKey: string): ChatBrowser => chats.get(chatKey) ?? EMPTY;

export function setBrowserOpen(chatKey: string, open: boolean) {
  update(chatKey, (chat) => {
    if (chat.open === open) return chat;
    // Opened with no page, it starts on a blank tab whose address bar takes the focus.
    if (open && !chat.tabs.length) {
      const tab = newTab("about:blank");
      return { open, tabs: [tab], active: tab.id };
    }
    return { ...chat, open };
  });
}

/** Shows the panel without adding a blank tab, for a Chat whose only pages are streamed ones (BrowserViewer.tsx). */
export function showBrowserPanel(chatKey: string) {
  update(chatKey, (chat) => (chat.open ? chat : { ...chat, open: true }));
}

const newTab = (url: string): BrowserTab => ({
  id: crypto.randomUUID(),
  url,
  title: "",
  loading: url !== "about:blank",
  canGoBack: false,
  canGoForward: false,
});

/**
 * Opens `url` in the Chat's Browser panel and shows the panel. A blank tab on screen takes it; otherwise it gets a new
 * tab, unless one already shows that exact address. `background` adds the tab without switching to it.
 */
export function openBrowserTab(chatKey: string, url: string, { background = false }: { background?: boolean } = {}): string {
  let id = "";
  update(chatKey, (chat) => {
    const same = chat.tabs.find((tab) => tab.url === url);
    if (same) {
      id = same.id;
      return { ...chat, open: true, active: background ? chat.active : same.id };
    }
    const active = chat.tabs.find((tab) => tab.id === chat.active);
    if (!background && active?.url === "about:blank") {
      id = active.id;
      navigations.set(active.id, url);
      return { ...chat, open: true, tabs: chat.tabs.map((tab) => (tab.id === active.id ? { ...tab, url, loading: true, error: undefined } : tab)) };
    }
    const tab = newTab(url);
    id = tab.id;
    return { open: true, tabs: [...chat.tabs, tab], active: background && chat.active ? chat.active : tab.id };
  });
  return id;
}

/** A blank tab, shown, for ⌘T and the + button. */
export function addBlankTab(chatKey: string) {
  update(chatKey, (chat) => {
    const tab = newTab("about:blank");
    return { open: true, tabs: [...chat.tabs, tab], active: tab.id };
  });
}

export function selectBrowserTab(chatKey: string, tabId: string) {
  update(chatKey, (chat) => (chat.active === tabId || !chat.tabs.some((tab) => tab.id === tabId) ? chat : { ...chat, active: tabId }));
}

/** Closes a tab; the one to its right shows next, or to its left. The last tab closing closes the panel. */
export function closeBrowserTab(chatKey: string, tabId: string) {
  update(chatKey, (chat) => {
    const index = chat.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return chat;
    const tabs = chat.tabs.filter((tab) => tab.id !== tabId);
    if (!tabs.length) return { open: false, tabs: [], active: null };
    const active = chat.active === tabId ? (tabs[index] ?? tabs[index - 1])!.id : chat.active;
    return { ...chat, tabs, active };
  });
}

/** What the page reported: its address after a navigation, title, favicon, loading and history state. */
export function patchBrowserTab(chatKey: string, tabId: string, patch: Partial<Omit<BrowserTab, "id">>) {
  update(chatKey, (chat) => {
    const tab = chat.tabs.find((item) => item.id === tabId);
    if (!tab || (Object.keys(patch) as (keyof typeof patch)[]).every((key) => tab[key] === patch[key])) return chat;
    return { ...chat, tabs: chat.tabs.map((item) => (item.id === tabId ? { ...item, ...patch } : item)) };
  });
}

// Addresses typed or opened into a tab that already has a page: the page layer loads them and clears the entry.
const navigations = new Map<string, string>();

/** Loads `url` in an existing tab, as the address bar does. */
export function navigateBrowserTab(chatKey: string, tabId: string, url: string) {
  navigations.set(tabId, url);
  // The new address shows at once; the page reports where it really landed.
  update(chatKey, (chat) => ({ ...chat, tabs: chat.tabs.map((tab) => (tab.id === tabId ? { ...tab, url, loading: true, error: undefined } : tab)) }));
}

/** The address a tab was asked to load since the page layer last looked, once. */
export function takeNavigation(tabId: string): string | undefined {
  const url = navigations.get(tabId);
  navigations.delete(tabId);
  return url;
}

/**
 * What the address bar makes of what was typed: a URL as is; a host with or without a port as a web address (http for
 * this machine and the local network, https otherwise); anything else as a search.
 */
export function addressToUrl(text: string): string {
  const typed = text.trim();
  if (!typed) return "about:blank";
  if (/^(https?:\/\/|about:blank$)/i.test(typed)) return typed;
  if (
    !/\s/.test(typed) &&
    /^[\w.-]+(:\d+)?([/?#].*)?$/.test(typed) &&
    (/^localhost(:|\/|$)/i.test(typed) || /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(typed))
  ) {
    const local = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[\w-]+\.local)(:|\/|$)/i.test(typed);
    return `${local ? "http" : "https"}://${typed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(typed)}`;
}

/** The address bar's text for a tab: empty for a blank one. */
export const addressText = (url: string) => (url === "about:blank" ? "" : url);

// The Chat whose panel takes a localhost link from a reply: the Chat on screen that last mounted a Browser panel.
const hosts: string[] = [];

/** Marks `chatKey`'s panel as able to take links while it is mounted. */
export function registerBrowserHost(chatKey: string) {
  hosts.push(chatKey);
  return () => {
    const index = hosts.lastIndexOf(chatKey);
    if (index >= 0) hosts.splice(index, 1);
  };
}

/** Opens a link in the Browser panel of the Chat on screen; false when no panel can take it (the caller opens it outside). */
export function openInBrowserPanel(url: string): boolean {
  const chatKey = hosts.at(-1);
  if (!chatKey) return false;
  openBrowserTab(chatKey, url);
  return true;
}
