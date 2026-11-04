import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import {
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  BrowserIcon,
  Cancel01Icon,
  Globe02Icon,
  Link01Icon,
  LinkSquare02Icon,
  PlusSignIcon,
  Refresh01Icon,
  Unlink04Icon,
} from "@hugeicons/core-free-icons";
import type { BrowserCandidate, BrowserTarget } from "@milagre/shared/browser";
import type { AgentPort } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { radioKeys } from "../primitives/Segmented";
import { dockLayer, useCloseWhenDesignsExpand, useDockArea, useSidePanelRoom } from "./dock-area";
import { useSidePanel } from "./PanelToggles";
import { ResizableDockSlide } from "./DockSlide";
import { MIN_CHAT_WIDTH, usePanelWidth } from "./panel-width";
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
  showBrowserPanel,
  useAllChatBrowsers,
  useChatBrowser,
  type BrowserTab,
} from "../../lib/browser-panel";
import { browserWebview, focusBrowserPage, listenToBrowserPages, showBrowserPage, syncBrowserPages } from "../../lib/browser-webviews";
import { portUrl } from "../../lib/ports";
import { CommentControls, PageCommenting, useSentPageComments, type SendPageComments } from "./BrowserComments";
import { shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { isRemoteKey } from "../../lib/computer-bridge";
import { targetBrowserId, useChatBrowserTargets, type ChatBrowserTargets } from "./BrowserViewer";

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

/**
 * A Chat's Browser panel, docked beside the chat left of a docked simulator: tabs, an address bar and the page. The
 * page itself is a <webview> in browser-webviews.ts, laid over this panel's slot, so it outlives the panel closing and
 * the Chat switching. `ports` are the Chat's listening servers, offered on a blank tab.
 *
 * Pages the panel didn't load (a browser the agent started, one attached to the Chat, or a Chat on another computer's
 * own panel pages) supply addresses to load here, read for `viewerChatId`.
 */
export function BrowserPanel({
  chatKey,
  viewerChatId,
  ports,
  onSendComments,
}: {
  chatKey: string;
  viewerChatId?: string;
  ports: AgentPort[];
  onSendComments?: SendPageComments;
}) {
  const chat = useChatBrowser(chatKey);
  const listed = useChatBrowserTargets(viewerChatId, chat.open);
  // Each device loads the page itself. A discovered page supplies an address, never a capture.
  const ownPages = new Set(chat.tabs.map((tab) => samePage(tab.url)));
  const streamed: ChatBrowserTargets = {
    ...listed,
    targets: listed.targets.filter((target) => !ownPages.has(samePage(target.url))),
  };
  const own = chat.tabs.find((tab) => tab.id === chat.active) ?? null;
  const first = streamed.targets.find((target) => /^https?:\/\//i.test(target.url));
  useEffect(() => {
    if (chat.open && !own && !streamed.loading) openBrowserTab(chatKey, first?.url ?? "about:blank");
  }, [chat.open, chatKey, own, first, streamed.loading]);
  const viewTarget = (id: string) => {
    const target = listed.targets.find((entry) => entry.id === id);
    if (target && /^https?:\/\//i.test(target.url)) openBrowserTab(chatKey, target.url);
  };
  const dock = useDockArea();
  const [expanded, setExpanded] = useState(false);
  const resize = usePanelWidth("browser");
  // Dragged wider than the room left now (the changes panel or a simulator opened beside it), it narrows so the chat
  // keeps its width, down to its minimum; wider, it would push the row past the window, over the sidebar.
  const width = dock ? Math.max(resize.min, Math.min(resize.width, dock.width - dock.simulator - 12 - MIN_CHAT_WIDTH)) : resize.width;
  const full = expanded;
  const close = useCallback(() => setBrowserOpen(chatKey, false), [chatKey]);
  useCloseWhenDesignsExpand(close);
  useSidePanelRoom("browser", chat.open && !full, width + 12, close);
  const hasStreamed = streamed.targets.length > 0;
  // Opened with only discovered pages (or while their initial read is in flight), show them rather than a blank page.
  const open = () => (!chatBrowser(chatKey).tabs.length && (hasStreamed || streamed.loading) ? showBrowserPanel(chatKey) : setBrowserOpen(chatKey, true));
  useSidePanel("browser", {
    open: chat.open,
    toggle: () => (chatBrowser(chatKey).open ? close() : open()),
  });
  const closeTab = (tabId: string) => {
    closeBrowserTab(chatKey, tabId);
    // The last page of its own closing leaves the discovered ones on show.
    if (!chatBrowser(chatKey).tabs.length && hasStreamed) showBrowserPanel(chatKey);
  };
  const selectTab = (tabId: string) => selectBrowserTab(chatKey, tabId);
  const attached = async (browserId: string) => {
    const next = await streamed.attach(browserId);
    const page = next?.targets.find((target) => targetBrowserId(target.id) === browserId && /^https?:\/\//i.test(target.url));
    if (page && /^https?:\/\//i.test(page.url)) openBrowserTab(chatKey, page.url);
  };
  // Localhost links in this Chat's replies open here while it is on screen.
  useEffect(() => registerBrowserHost(chatKey), [chatKey]);
  useSentPageComments(chatKey);
  const active = own;
  return createPortal(
    <AnimatePresence>
      {chat.open && active && (
        <ResizableDockSlide
          key="browser-dock"
          // Opens like the git changes panel and lines up with the sidebar's card, left of a docked simulator; the chat
          // makes room through --browser-dock.
          panel="browser"
          label="Resize browser"
          width={full ? null : width}
          reserve="--browser-dock"
          role="region"
          aria-label="Browser"
          data-slot="browser-dock"
          data-full={full || undefined}
          style={
            full
              ? {
                  top: dock?.top ?? 40,
                  left: dock?.left ?? 0,
                  right: `calc(${(dock?.right ?? 0) + 12}px + var(--simulator-dock, 0px))`,
                  bottom: dock?.bottom ?? 12,
                }
              : {
                  top: dock?.top ?? 40,
                  right: `calc(${(dock?.right ?? 0) + 12}px + var(--simulator-dock, 0px))`,
                  bottom: dock?.bottom ?? 12,
                }
          }
          className="fixed z-[41]"
          panelClassName="overflow-hidden rounded-window bg-surface text-ink shadow-card"
        >
          <BrowserTabs
            chatKey={chatKey}
            tabs={chat.tabs}
            active={active?.id ?? null}
            streamed={streamed}
            attachedTargets={listed.targets.filter((target) => target.source === "attached")}
            viewing={null}
            pages={{}}
            onSelect={selectTab}
            onCloseTab={closeTab}
            onView={viewTarget}
            onClose={close}
            expanded={expanded}
            onToggleExpanded={() => setExpanded((value) => !value)}
          />
          <BrowserToolbar key={active.id} chatKey={chatKey} tab={active} onSendComments={onSendComments} />
          <BrowserPage chatKey={chatKey} tab={active} ports={ports} streamed={streamed} onAttach={attached} />
        </ResizableDockSlide>
      )}
    </AnimatePresence>,
    dockLayer(),
  );
}

function BrowserTabs({
  chatKey,
  tabs,
  attachedTargets,
  active,
  streamed,
  viewing,
  pages,
  onSelect,
  onCloseTab,
  onView,
  onClose,
  expanded,
  onToggleExpanded,
}: {
  chatKey: string;
  tabs: BrowserTab[];
  attachedTargets: BrowserTarget[];
  active: string | null;
  streamed: ChatBrowserTargets;
  viewing: string | null;
  pages: Record<string, { title: string; url: string }>;
  onSelect: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onView: (targetId: string) => void;
  onClose: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const { rules } = useKeybindings();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      {/* The Tabs look and keys (one Tab stop, the arrows pick), with a close button per tab. */}
      <div
        role="tablist"
        aria-label="Pages"
        onKeyDown={radioKeys({ role: "tab", axis: "horizontal" })}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const attached = attachedTargets.find((target) => samePage(target.url) === samePage(tab.url));
          const name = tab.title || (tab.url === "about:blank" ? "New page" : hostLabel(tab.url));
          return (
            <div
              key={tab.id}
              data-browser-tab={tab.id}
              // A middle click closes the tab, as in a browser.
              onAuxClick={(event) => {
                if (event.button === 1) onCloseTab(tab.id);
              }}
              className={`group flex h-7 min-w-0 max-w-[180px] flex-1 basis-[140px] items-center gap-1.5 rounded-control pr-1 pl-2 text-12 font-medium transition-colors ${selected ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
            >
              <Tooltip label={addressText(tab.url) || name} side="bottom" className="min-w-0 flex-1">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelect(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <TabIcon tab={tab} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
              </Tooltip>
              {attached && (
                <IconButton
                  label={`Detach ${name} from this Chat`}
                  icon={Unlink04Icon}
                  size={20}
                  data-browser-detach={targetBrowserId(attached.id)}
                  disabled={streamed.attaching !== null}
                  onClick={() => void streamed.detach(targetBrowserId(attached.id))}
                />
              )}
              <IconButton
                label={`Close ${name}`}
                icon={Cancel01Icon}
                size={20}
                onClick={() => onCloseTab(tab.id)}
                className={selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}
              />
            </div>
          );
        })}
        {streamed.targets.map((target) => (
          <DiscoveredTab
            key={target.id}
            target={target}
            page={pages[target.id]}
            selected={target.id === viewing}
            detaching={streamed.attaching !== null}
            onView={() => onView(target.id)}
            onDetach={() => void streamed.detach(targetBrowserId(target.id))}
          />
        ))}
      </div>
      <IconButton label="New page" icon={PlusSignIcon} side="bottom" onClick={() => addBlankTab(chatKey)} />
      <IconButton
        label={expanded ? "Restore browser" : "Maximize browser"}
        icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
        aria-pressed={expanded}
        onClick={onToggleExpanded}
      />
      <Tooltip label="Hide Browser panel" shortcut={shortcutLabel(rules, "browser.toggle")} side="bottom" align="end">
        <IconButton label="Hide Browser panel" icon={Cancel01Icon} onClick={onClose} />
      </Tooltip>
    </div>
  );
}

const SOURCE_LABEL: Record<BrowserTarget["source"], string> = {
  agent: "Agent's browser",
  attached: "Attached",
  panel: "Its computer's panel",
};

/** An address offered by the agent's own browser, an attached one or another computer's panel. */
function DiscoveredTab({
  target,
  page,
  selected,
  detaching,
  onView,
  onDetach,
}: {
  target: BrowserTarget;
  page?: { title: string; url: string };
  selected: boolean;
  detaching: boolean;
  onView: () => void;
  onDetach: () => void;
}) {
  const url = page?.url || target.url;
  const name = page?.title || target.title || hostLabel(url);
  return (
    <div
      data-browser-target={target.id}
      className={`group flex h-7 min-w-0 max-w-[180px] flex-1 basis-[140px] items-center gap-1.5 rounded-control pr-1 pl-2 text-12 ${selected ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover/60"}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={`${SOURCE_LABEL[target.source]} · ${url}`}
        onClick={onView}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Icon icon={BrowserIcon} size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
      </button>
      {/* Only an attachment can end here: the agent's browser and another computer's panel close where they run. */}
      {target.source === "attached" && (
        <Tooltip label="Detach this browser from this Chat" side="bottom">
          <button
            type="button"
            aria-label={`Detach ${name} from this Chat`}
            data-browser-detach={targetBrowserId(target.id)}
            disabled={detaching}
            onClick={onDetach}
            className={`flex size-5 shrink-0 items-center justify-center rounded-inline text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-40 ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
          >
            <Icon icon={Unlink04Icon} size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function TabIcon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = useState(false);
  if (tab.loading) return <SpinnerRing size={12} />;
  if (tab.favicon && !broken) return <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-inline" onError={() => setBroken(true)} />;
  return <Icon icon={Globe02Icon} size={14} className="shrink-0 text-ink-3" />;
}

/** An address as a page: its fragment and a trailing slash don't make another one. */
const samePage = (url: string) => url.replace(/#.*$/, "").replace(/\/$/, "");

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
      <IconButton label="Back" icon={ArrowLeft01Icon} side="bottom" disabled={!tab.canGoBack} onClick={() => page()?.goBack()} />
      <IconButton label="Forward" icon={ArrowRight01Icon} side="bottom" disabled={!tab.canGoForward} onClick={() => page()?.goForward()} />
      <Tooltip label={tab.loading ? "Stop" : "Reload"} shortcut={tab.loading ? undefined : "⌘R"} side="bottom">
        <IconButton label={tab.loading ? "Stop loading" : "Reload"} icon={tab.loading ? Cancel01Icon : Refresh01Icon} disabled={blank} onClick={reload} />
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
        className="h-7 min-w-0 flex-1 rounded-control border border-transparent bg-hover px-2.5 text-12 text-ink outline-none transition-colors placeholder:text-ink-3 focus:bg-surface"
      />
      <CommentControls chatKey={chatKey} live={!blank && !tab.error} onSend={onSendComments} />
      <Tooltip label="Open in your default browser" side="bottom" align="end">
        <IconButton label="Open in your default browser" icon={LinkSquare02Icon} disabled={blank} onClick={() => window.open(tab.url, "_blank")} />
      </Tooltip>
    </form>
  );
}

/**
 * Where the page shows: the slot the page's webview is laid over. A blank tab offers the Chat's servers instead, and a
 * page that didn't load says why, with the page set aside.
 */
function BrowserPage({
  chatKey,
  tab,
  ports,
  streamed,
  onAttach,
}: {
  chatKey: string;
  tab: BrowserTab;
  ports: AgentPort[];
  streamed: ChatBrowserTargets;
  onAttach: (browserId: string) => void;
}) {
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
          <p className="max-w-[320px] text-13 text-ink-2">{tab.error}</p>
          <Button variant="secondary" size={28} onClick={() => navigateBrowserTab(chatKey, tab.id, tab.url)}>
            Try again
          </Button>
        </div>
      ) : !live ? (
        <StartPage chatKey={chatKey} ports={ports} streamed={streamed} onAttach={onAttach} />
      ) : null}
      <PageCommenting chatKey={chatKey} tab={tab} live={live} />
    </div>
  );
}

function StartPage({
  chatKey,
  ports,
  streamed,
  onAttach,
}: {
  chatKey: string;
  ports: AgentPort[];
  streamed: ChatBrowserTargets;
  onAttach: (browserId: string) => void;
}) {
  // This Mac's servers only: the panel opens pages here.
  const servers = ports.filter((port) => !port.computerId).sort((a, b) => a.port - b.port);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <Icon icon={Globe02Icon} size={18} className="text-ink-4" />
      {servers.length ? (
        <div className="flex w-full max-w-[300px] flex-col gap-1">
          <p className="mb-1 text-center text-12 text-ink-3">This Chat's servers</p>
          {servers.map((port) => {
            const url = portUrl(port)!;
            return (
              <button
                key={port.port}
                type="button"
                data-browser-port={port.port}
                onClick={() => openBrowserTab(chatKey, url)}
                className="flex h-8 items-center gap-2 rounded-control px-3 text-left text-13 transition-colors hover:bg-hover active:bg-hover-2"
              >
                <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3">{port.command}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="max-w-[280px] text-center text-12 text-ink-3">Enter an address above, like localhost:3000. Servers this Chat starts show here too.</p>
      )}
      {streamed.others.length > 0 && <OtherBrowsers chatKey={chatKey} streamed={streamed} onAttach={onAttach} />}
      {streamed.error && (
        <p role="alert" className="max-w-[300px] text-center text-12 text-red-ink">
          {streamed.error}
        </p>
      )}
    </div>
  );
}

/** Browsers no Chat's agent started, on the Chat's computer. Attaching one offers its pages here, as tabs. */
function OtherBrowsers({ chatKey, streamed, onAttach }: { chatKey: string; streamed: ChatBrowserTargets; onAttach: (browserId: string) => void }) {
  return (
    <div className="flex w-full max-w-[300px] flex-col gap-1">
      <p className="mb-1 text-center text-12 text-ink-3">{isRemoteKey(chatKey) ? "Other browsers on its computer" : "Other browsers on this computer"}</p>
      {streamed.others.map((other: BrowserCandidate) => (
        <div key={other.id} data-browser-other={other.id} className="flex items-center gap-2 rounded-control px-3 py-1.5">
          <Icon icon={BrowserIcon} size={16} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-13">{other.title || other.browser}</span>
            <span className="block truncate text-11 text-ink-3">
              {other.browser} · {other.pages} {other.pages === 1 ? "page" : "pages"}
            </span>
          </span>
          <Tooltip label="Show this browser's pages in this Chat" side="bottom" align="end">
            <button
              type="button"
              aria-label={`Attach ${other.title || other.browser} to this Chat`}
              disabled={streamed.attaching !== null}
              onClick={() => onAttach(other.id)}
              className="flex h-7 shrink-0 items-center gap-1 rounded-control px-2 text-12 text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
            >
              <Icon icon={Link01Icon} size={14} />
              Attach
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
