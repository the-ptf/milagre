import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, Globe02Icon, LinkSquare02Icon, PlusSignIcon, Refresh01Icon } from "@hugeicons/core-free-icons";
import type { AgentPort } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { dockLayer, useCloseWhenDesignsExpand, useDockArea, useSidePanelRoom } from "./dock-area";
import { useSidePanel } from "./PanelToggles";
import { ResizableDockSlide } from "./DockSlide";
import { usePanelWidth } from "./panel-width";
import {
  addBlankTab,
  addressText,
  addressToUrl,
  chatBrowser,
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  registerBrowserHost,
  selectBrowserTab,
  setBrowserOpen,
  useAllChatBrowsers,
  useChatBrowser,
  type BrowserTab,
} from "../../lib/browser-panel";
import { browserWebview, focusBrowserPage, listenToBrowserPages, showBrowserPage, syncBrowserPages } from "../../lib/browser-webviews";
import { portUrl } from "../../lib/ports";
import { CommentControls, PageCommenting, useSentPageComments, type SendPageComments } from "./BrowserComments";
import { shortcutLabel, useKeybindings } from "../../lib/keybindings";

/** Sent with a Chat key when ⌘L is pressed in one of its pages: its address bar takes the focus. */
const FOCUS_BROWSER_ADDRESS = "milagre:browser-address";

/** Keeps every Chat's pages in line with its tabs, and takes main's page events. Mounted once, beside the app. */
export function BrowserPages() {
  const chats = useAllChatBrowsers();
  useEffect(() => syncBrowserPages(chats), [chats]);
  useEffect(
    () =>
      listenToBrowserPages((chatKey, _tabId, key) => {
        if (key === "l") window.dispatchEvent(new CustomEvent(FOCUS_BROWSER_ADDRESS, { detail: chatKey }));
      }),
    [],
  );
  return null;
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent";

/**
 * A Chat's Browser panel, docked beside the chat left of a docked simulator: tabs, an address bar and the page. The
 * page itself is a <webview> in browser-webviews.ts, laid over this panel's slot, so it outlives the panel closing and
 * the Chat switching. `ports` are the Chat's listening servers, offered on a blank tab.
 */
export function BrowserPanel({ chatKey, ports, onSendComments }: { chatKey: string; ports: AgentPort[]; onSendComments?: SendPageComments }) {
  const chat = useChatBrowser(chatKey);
  const dock = useDockArea();
  const resize = usePanelWidth("browser");
  const close = useCallback(() => setBrowserOpen(chatKey, false), [chatKey]);
  useCloseWhenDesignsExpand(close);
  useSidePanelRoom("browser", chat.open, resize.width + 12, close);
  useSidePanel("browser", { open: chat.open, toggle: () => setBrowserOpen(chatKey, !chatBrowser(chatKey).open) });
  // Localhost links in this Chat's replies open here while it is on screen.
  useEffect(() => registerBrowserHost(chatKey), [chatKey]);
  useSentPageComments(chatKey);
  const active = chat.tabs.find((tab) => tab.id === chat.active) ?? null;
  return createPortal(
    <AnimatePresence>
      {chat.open && active && (
        <ResizableDockSlide
          key="browser-dock"
          // Opens like the git changes panel and lines up with the sidebar's card, left of a docked simulator; the chat
          // makes room through --browser-dock.
          panel="browser"
          label="Resize browser"
          width={resize.width}
          reserve="--browser-dock"
          role="region"
          aria-label="Browser"
          data-slot="browser-dock"
          style={{
            top: dock?.top ?? 40,
            right: `calc(${(dock?.right ?? 0) + 12}px + var(--simulator-dock, 0px))`,
            bottom: dock?.bottom ?? 12,
          }}
          className="fixed z-[41]"
          panelClassName="overflow-hidden rounded-window bg-surface text-ink shadow-card"
        >
          <BrowserTabs chatKey={chatKey} tabs={chat.tabs} active={active.id} onClose={close} />
          <BrowserToolbar key={active.id} chatKey={chatKey} tab={active} onSendComments={onSendComments} />
          <BrowserPage chatKey={chatKey} tab={active} ports={ports} />
        </ResizableDockSlide>
      )}
    </AnimatePresence>,
    dockLayer(),
  );
}

function BrowserTabs({ chatKey, tabs, active, onClose }: { chatKey: string; tabs: BrowserTab[]; active: string; onClose: () => void }) {
  const { rules } = useKeybindings();
  return (
    <div role="tablist" aria-label="Pages" className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const name = tab.title || (tab.url === "about:blank" ? "New page" : hostLabel(tab.url));
          return (
            <div
              key={tab.id}
              data-browser-tab={tab.id}
              className={`group flex h-7 min-w-0 max-w-[180px] flex-1 basis-[140px] items-center gap-1.5 rounded-control pr-1 pl-2 text-[12px] ${selected ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover/60"}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={addressText(tab.url) || name}
                onClick={() => selectBrowserTab(chatKey, tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${name}`}
                onClick={() => closeBrowserTab(chatKey, tab.id)}
                className={`flex size-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <Tooltip label="New page" side="bottom">
        <button type="button" aria-label="New page" onClick={() => addBlankTab(chatKey)} className={ICON_BUTTON}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label="Hide browser" shortcut={shortcutLabel(rules, "browser.toggle")} side="bottom" align="end">
        <button type="button" aria-label="Hide browser" onClick={onClose} className={ICON_BUTTON}>
          <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

function TabIcon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = useState(false);
  if (tab.loading) return <SpinnerRing size={12} />;
  if (tab.favicon && !broken) return <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[3px]" onError={() => setBroken(true)} />;
  return <HugeiconsIcon icon={Globe02Icon} size={14} className="shrink-0 text-ink-3" aria-hidden />;
}

const hostLabel = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function BrowserToolbar({ chatKey, tab, onSendComments }: { chatKey: string; tab: BrowserTab; onSendComments?: SendPageComments }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(addressText(tab.url));
  const [editing, setEditing] = useState(false);
  // The address follows the page while the field isn't being typed in.
  useEffect(() => {
    if (!editing) setText(addressText(tab.url));
  }, [tab.url, editing]);
  // A blank tab starts with the address bar focused; ⌘L in the page focuses it too.
  useEffect(() => {
    if (tab.url === "about:blank") input.current?.focus();
    const focus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== chatKey) return;
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener(FOCUS_BROWSER_ADDRESS, focus);
    return () => window.removeEventListener(FOCUS_BROWSER_ADDRESS, focus);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the tab first shows
  }, [chatKey]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = addressToUrl(text);
    setEditing(false);
    navigateBrowserTab(chatKey, tab.id, url);
    input.current?.blur();
    focusBrowserPage(tab.id);
  };
  const page = () => browserWebview(tab.id);
  const reload = () => {
    if (tab.loading) page()?.stop();
    else if (page()) page()!.reload();
    // A page that never loaded (its server was down) has no webview yet to reload: load its address again.
    else navigateBrowserTab(chatKey, tab.id, tab.url);
  };
  const blank = tab.url === "about:blank";
  return (
    <form onSubmit={submit} className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      <Tooltip label="Back" side="bottom">
        <button type="button" aria-label="Back" disabled={!tab.canGoBack} onClick={() => page()?.goBack()} className={ICON_BUTTON}>
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label="Forward" side="bottom">
        <button type="button" aria-label="Forward" disabled={!tab.canGoForward} onClick={() => page()?.goForward()} className={ICON_BUTTON}>
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label={tab.loading ? "Stop" : "Reload"} shortcut={tab.loading ? undefined : "⌘R"} side="bottom">
        <button type="button" aria-label={tab.loading ? "Stop loading" : "Reload"} disabled={blank} onClick={reload} className={ICON_BUTTON}>
          <HugeiconsIcon icon={tab.loading ? Cancel01Icon : Refresh01Icon} size={15} aria-hidden />
        </button>
      </Tooltip>
      <input
        ref={input}
        aria-label="Address"
        data-slot="browser-address"
        value={text}
        placeholder="Search or enter an address"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => {
          setEditing(true);
          setText(event.target.value);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          setEditing(false);
          setText(addressText(tab.url));
          event.currentTarget.blur();
        }}
        className="h-7 min-w-0 flex-1 rounded-control border border-transparent bg-hover px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-line-strong focus:bg-surface"
      />
      <CommentControls chatKey={chatKey} live={!blank && !tab.error} onSend={onSendComments} />
      <Tooltip label="Open in your browser" side="bottom" align="end">
        <button type="button" aria-label="Open in your browser" disabled={blank} onClick={() => window.open(tab.url, "_blank")} className={ICON_BUTTON}>
          <HugeiconsIcon icon={LinkSquare02Icon} size={15} aria-hidden />
        </button>
      </Tooltip>
    </form>
  );
}

/**
 * Where the page shows: the slot the page's webview is laid over. A blank tab offers the Chat's servers instead, and a
 * page that didn't load says why, with the page set aside.
 */
function BrowserPage({ chatKey, tab, ports }: { chatKey: string; tab: BrowserTab; ports: AgentPort[] }) {
  const slot = useRef<HTMLDivElement>(null);
  const live = tab.url !== "about:blank" && !tab.error;
  useEffect(() => {
    if (!live || !slot.current) return;
    return showBrowserPage(chatKey, tab.id, slot.current);
  }, [chatKey, tab.id, live]);
  return (
    <div ref={slot} data-slot="browser-page" className="relative min-h-0 flex-1 bg-surface">
      {tab.error ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="max-w-[320px] text-[13px] text-ink-2">{tab.error}</p>
          <button
            type="button"
            onClick={() => navigateBrowserTab(chatKey, tab.id, tab.url)}
            className="rounded-control border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-hover"
          >
            Try again
          </button>
        </div>
      ) : !live ? (
        <StartPage chatKey={chatKey} ports={ports} />
      ) : null}
      <PageCommenting chatKey={chatKey} tab={tab} live={live} />
    </div>
  );
}

function StartPage({ chatKey, ports }: { chatKey: string; ports: AgentPort[] }) {
  // This Mac's servers only: the panel opens pages here.
  const servers = ports.filter((port) => !port.computerId).sort((a, b) => a.port - b.port);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <HugeiconsIcon icon={Globe02Icon} size={28} className="text-ink-3" aria-hidden />
      {servers.length ? (
        <div className="flex w-full max-w-[300px] flex-col gap-1">
          <p className="mb-1 text-center text-[12px] text-ink-3">This Chat's servers</p>
          {servers.map((port) => {
            const url = portUrl(port)!;
            return (
              <button
                key={port.port}
                type="button"
                data-browser-port={port.port}
                onClick={() => openBrowserTab(chatKey, url)}
                className="flex items-center gap-2 rounded-control px-3 py-2 text-left text-[13px] hover:bg-hover"
              >
                <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3">{port.command}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="max-w-[280px] text-center text-[12px] text-ink-3">Enter an address above. When the agent starts a server, it shows here.</p>
      )}
    </div>
  );
}
