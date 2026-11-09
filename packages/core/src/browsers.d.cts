import type { BrowserFrame, BrowserInput, BrowserList, BrowserOpen, BrowserStatus } from "@milagre/shared/browser";
export interface BrowserPage {
  id: string;
  title: string;
  url: string;
}
/** Internal discovery record. `host` and `port` stay inside the host and are never returned to clients. */
export interface DiscoveredBrowser {
  id: string;
  pid: number;
  host: string;
  port: number;
  /** A Browser panel's token path (cdp-proxy.cjs); real browsers have none. */
  prefix?: string;
  product: string;
  pages: BrowserPage[];
}
export interface BrowserChannel {
  status(): Omit<BrowserStatus, "generation" | "controlling"> & { width: number; height: number; error?: string };
  frame(): Omit<BrowserFrame, "generation"> | null;
  onFrame(listener: () => void): () => void;
  send(event: BrowserInput): void;
  close(): Promise<void>;
}
export interface BrowserAdapter {
  discover(): Promise<{ processes: { pid: number; ppid: number }[]; browsers: DiscoveredBrowser[] }>;
  connect(browser: DiscoveredBrowser, pageId: string): Promise<BrowserChannel>;
  stop(): Promise<void>;
}
export interface BrowserOptions {
  adapter?: BrowserAdapter;
  /** Each Chat's agent process, the root of its ownership evidence. */
  roots?: () => Map<string, { pid: number }>;
  supported?: boolean;
  viewerTtlMs?: number;
  maxViewers?: number;
  frameWaitMs?: number;
  now?: () => number;
}
export interface Browsers {
  list(request: { chatId: string }): Promise<BrowserList>;
  attach(request: { chatId: string; browserId: string }): Promise<BrowserList>;
  open(request: { chatId: string; targetId: string }, owner: string): Promise<BrowserOpen>;
  frame(request: { viewerId: string; after: number }, owner: string): Promise<BrowserFrame | null>;
  status(request: { viewerId: string }, owner: string): Promise<BrowserStatus>;
  control(request: { viewerId: string; takeOver: boolean }, owner: string): Promise<BrowserStatus>;
  input(request: { viewerId: string; sequence: number; generation: number; event: BrowserInput }, owner: string): Promise<{ accepted: boolean }>;
  closeViewer(request: { viewerId: string }, owner: string): Promise<null>;
  /** A desktop's Browser panel pages and their loopback DevTools endpoint; an empty list takes them away. */
  setPanelPages(
    request: { port?: number; prefix?: string; pages: { id: string; chatId: string; title: string; url: string }[] },
    owner: string,
  ): Promise<{ pages: number }>;
  disconnect(owner: string): Promise<void>;
  close(): Promise<void>;
}
export function createBrowsers(options?: BrowserOptions): Browsers;
