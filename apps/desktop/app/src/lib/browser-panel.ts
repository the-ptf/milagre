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
  error?: string;
};

export type ChatBrowser = { open: boolean; tabs: BrowserTab[]; active: string | null };

const EMPTY: ChatBrowser = { open: false, tabs: [], active: null };
const STORAGE_KEY = "milagre.browserPanel";
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
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(kept.map(([chat, { open, tabs, active }]) => [chat, { open, active, tabs: tabs.map(({ id, url, title }) => ({ id, url, title })) }])),
      );
    } catch {}
  }, 300);
}

const changed = new Set<string>();
export const changedThisLaunch = (chatKey: string) => changed.has(chatKey);

function update(chatKey: string, change: (chat: ChatBrowser) => ChatBrowser) {
  const before = chats.get(chatKey) ?? EMPTY;
  const after = change(before);
  if (after === before) return;
  changed.add(chatKey);
  const next = new Map(chats);
  next.delete(chatKey);
  next.set(chatKey, after);
  chats = next;
  save();
  for (const listener of listeners) listener();
}

export function useChatBrowser(chatKey: string | null): ChatBrowser {
  return useSyncExternalStore(subscribe, () => (chatKey ? (chats.get(chatKey) ?? EMPTY) : EMPTY));
}

export function useAllChatBrowsers(): ReadonlyMap<string, ChatBrowser> {
  return useSyncExternalStore(subscribe, () => chats);
}

export const chatBrowser = (chatKey: string): ChatBrowser => chats.get(chatKey) ?? EMPTY;

export function setBrowserOpen(chatKey: string, open: boolean) {
  update(chatKey, (chat) => {
    if (chat.open === open) return chat;
    if (open && !chat.tabs.length) {
      const tab = newTab("about:blank");
      return { open, tabs: [tab], active: tab.id };
    }
    return { ...chat, open };
  });
}

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

const agentPages = new Set<string>();

/** Whether the agent opened the page (browser_open), so a Workspace tab for it lands unread instead of in front. */
export const openedByAgent = (tabId: string) => agentPages.has(tabId);

export function openBrowserTab(chatKey: string, url: string, { background = false, agent = false }: { background?: boolean; agent?: boolean } = {}): string {
  const id = openPage(chatKey, url, background);
  if (agent && id) agentPages.add(id);
  return id;
}

function openPage(chatKey: string, url: string, background: boolean): string {
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

export function addBlankTab(chatKey: string) {
  update(chatKey, (chat) => {
    const tab = newTab("about:blank");
    return { open: true, tabs: [...chat.tabs, tab], active: tab.id };
  });
}

export function selectBrowserTab(chatKey: string, tabId: string) {
  update(chatKey, (chat) => (chat.active === tabId || !chat.tabs.some((tab) => tab.id === tabId) ? chat : { ...chat, active: tabId }));
}

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

export function closeBrowserTabs(chatKey: string): number {
  let closed = 0;
  update(chatKey, (chat) => {
    closed = chat.tabs.length;
    if (!closed && !chat.open) return chat;
    return { open: false, tabs: [], active: null };
  });
  return closed;
}

export function patchBrowserTab(chatKey: string, tabId: string, patch: Partial<Omit<BrowserTab, "id">>) {
  update(chatKey, (chat) => {
    const tab = chat.tabs.find((item) => item.id === tabId);
    if (!tab || (Object.keys(patch) as (keyof typeof patch)[]).every((key) => tab[key] === patch[key])) return chat;
    return { ...chat, tabs: chat.tabs.map((item) => (item.id === tabId ? { ...item, ...patch } : item)) };
  });
}

const navigations = new Map<string, string>();

export function navigateBrowserTab(chatKey: string, tabId: string, url: string) {
  navigations.set(tabId, url);
  update(chatKey, (chat) => ({ ...chat, tabs: chat.tabs.map((tab) => (tab.id === tabId ? { ...tab, url, loading: true, error: undefined } : tab)) }));
}

export function takeNavigation(tabId: string): string | undefined {
  const url = navigations.get(tabId);
  navigations.delete(tabId);
  return url;
}

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

export const addressText = (url: string) => (url === "about:blank" ? "" : url);

const hosts: string[] = [];

export function registerBrowserHost(chatKey: string) {
  hosts.push(chatKey);
  return () => {
    const index = hosts.lastIndexOf(chatKey);
    if (index >= 0) hosts.splice(index, 1);
  };
}

export const hasBrowserPanel = () => hosts.length > 0;

export function openInBrowserPanel(url: string): boolean {
  const chatKey = hosts.at(-1);
  if (!chatKey) return false;
  openBrowserTab(chatKey, url);
  return true;
}
