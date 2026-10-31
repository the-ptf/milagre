import { useCallback, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BrowserIcon,
  Cancel01Icon,
  CommentAdd01Icon,
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
import { LoopbackPortsContext, portUrl } from "../../lib/ports";
import { useComputers } from "../../lib/computers";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { openablePageUrl } from "@milagre/shared/loopback-url";
import { CommentControls, PageCommenting, StreamedPageComment, useSentPageComments, type SendPageComments } from "./BrowserComments";
import { shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { isRemoteKey } from "../../lib/computer-bridge";
import { BrowserViewerFrame, targetBrowserId, useChatBrowserTargets, type ChatBrowserTargets, type StreamedPoint } from "./BrowserViewer";

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
 *
 * Pages the panel didn't load (a browser the agent started, one attached to the Chat, or a Chat on another computer's
 * own panel pages) show as streamed tabs after its own, read for `viewerChatId`.
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
  // The streamed page picked, over the page of its own then on show: another of its own coming on show (picked, opened
  // from a link or a new tab) takes over.
  const [picked, setPicked] = useState<{ target: string; over: string | null } | null>(null);
  const viewing = picked && picked.over === chat.active ? picked.target : null;
  const setViewing = useCallback((target: string | null) => setPicked(target ? { target, over: chatBrowser(chatKey).active } : null), [chatKey]);
  // What each streamed page reported last: its title and address follow the page as it navigates.
  const [pages, setPages] = useState<Record<string, { title: string; url: string }>>({});
  // A remote Chat's own tab at an address is that page drawn here (#832): the copy streamed from its computer's panel goes.
  const ownPages = new Set(chat.tabs.map((tab) => samePage(tab.url)));
  const streamed: ChatBrowserTargets = {
    ...listed,
    targets: listed.targets.filter((target) => target.source !== "panel" || !ownPages.has(samePage(pages[target.id]?.url || target.url))),
  };
  const own = chat.tabs.find((tab) => tab.id === chat.active) ?? null;
  // The streamed page on show: the one picked, or the first while the panel has no page of its own.
  const viewer = streamed.targets.find((target) => target.id === viewing) ?? (own ? null : (streamed.targets[0] ?? null));
  const dock = useDockArea();
  const resize = usePanelWidth("browser");
  // Dragged wider than the room left now (the changes panel or a simulator opened beside it), it narrows so the chat
  // keeps its width, down to its minimum; wider, it would push the row past the window, over the sidebar.
  const width = dock ? Math.max(resize.min, Math.min(resize.width, dock.width - dock.simulator - 12 - MIN_CHAT_WIDTH)) : resize.width;
  const close = useCallback(() => setBrowserOpen(chatKey, false), [chatKey]);
  useCloseWhenDesignsExpand(close);
  useSidePanelRoom("browser", chat.open, width + 12, close);
  const hasStreamed = streamed.targets.length > 0;
  // Opened with only streamed pages, the panel shows them rather than a blank page.
  const open = () => (!chatBrowser(chatKey).tabs.length && hasStreamed ? showBrowserPanel(chatKey) : setBrowserOpen(chatKey, true));
  // Keep opening a blank page available in the menu and by shortcut; promote it once a page exists.
  useSidePanel("browser", {
    open: chat.open,
    promoted: chat.tabs.length > 0 || hasStreamed,
    toggle: () => (chatBrowser(chatKey).open ? close() : open()),
  });
  // Shown for streamed pages that have all gone, the panel closes.
  const empty = chat.open && !own && !viewer && !streamed.loading;
  useEffect(() => {
    if (empty) close();
  }, [empty, close]);
  const closeTab = (tabId: string) => {
    closeBrowserTab(chatKey, tabId);
    // The last page of its own closing leaves the streamed ones on show.
    if (!chatBrowser(chatKey).tabs.length && hasStreamed) showBrowserPanel(chatKey);
  };
  const selectTab = (tabId: string) => {
    setViewing(null);
    selectBrowserTab(chatKey, tabId);
  };
  const onPage = useCallback(
    (targetId: string, page: { title: string; url: string }) =>
      setPages((current) => (current[targetId]?.title === page.title && current[targetId]?.url === page.url ? current : { ...current, [targetId]: page })),
    [],
  );
  const attached = async (browserId: string) => {
    const next = await streamed.attach(browserId);
    const page = next?.targets.find((target) => targetBrowserId(target.id) === browserId);
    if (page) setViewing(page.id);
  };
  // Localhost links in this Chat's replies open here while it is on screen.
  useEffect(() => registerBrowserHost(chatKey), [chatKey]);
  useSentPageComments(chatKey);
  const active = viewer ? null : own;
  // Comment mode on the streamed page on show (another computer's panel page), and the point picked on it. Another page
  // or address ends it.
  const [streamComment, setStreamComment] = useState<{ target: string; url: string; point: StreamedPoint | null } | null>(null);
  const viewerUrl = viewer ? pages[viewer.id]?.url || viewer.url : "";
  const commenting = !!viewer && streamComment?.target === viewer.id && streamComment.url === viewerUrl ? streamComment : null;
  const [sentNote, setSentNote] = useState(false);
  useEffect(() => {
    if (!sentNote) return;
    const timer = setTimeout(() => setSentNote(false), 2500);
    return () => clearTimeout(timer);
  }, [sentNote]);
  return createPortal(
    <AnimatePresence>
      {chat.open && (active || viewer) && (
        <ResizableDockSlide
          key="browser-dock"
          // Opens like the git changes panel and lines up with the sidebar's card, left of a docked simulator; the chat
          // makes room through --browser-dock.
          panel="browser"
          label="Resize browser"
          width={width}
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
          <BrowserTabs
            chatKey={chatKey}
            tabs={chat.tabs}
            active={active?.id ?? null}
            streamed={streamed}
            viewing={viewer?.id ?? null}
            pages={pages}
            onSelect={selectTab}
            onCloseTab={closeTab}
            onView={setViewing}
            onClose={close}
          />
          {active ? (
            <>
              <BrowserToolbar key={active.id} chatKey={chatKey} tab={active} onSendComments={onSendComments} />
              <BrowserPage chatKey={chatKey} tab={active} ports={ports} streamed={streamed} onAttach={attached} />
            </>
          ) : (
            viewer &&
            streamed.api &&
            viewerChatId && (
              <>
                <ViewerToolbar
                  chatKey={chatKey}
                  target={viewer}
                  page={pages[viewer.id]}
                  commenting={!!commenting}
                  onComment={() => setStreamComment(commenting ? null : { target: viewer.id, url: viewerUrl, point: null })}
                />
                <div data-slot="browser-page" className="relative min-h-0 flex-1 bg-surface">
                  <BrowserViewerFrame
                    key={viewer.id}
                    api={streamed.api}
                    chatId={viewerChatId}
                    targetId={viewer.id}
                    onPage={(page) => onPage(viewer.id, page)}
                    commenting={!!commenting}
                    picked={commenting?.point ?? null}
                    onPick={(point) => setStreamComment((current) => (current ? { ...current, point } : current))}
                    onEscape={() => setStreamComment(null)}
                  />
                  {commenting && (
                    <StreamedPageComment
                      key={`${commenting.point?.x}:${commenting.point?.y}`}
                      chatId={viewerChatId}
                      targetId={viewer.id}
                      picked={commenting.point}
                      onCancel={() => setStreamComment(null)}
                      onSent={() => {
                        setStreamComment(null);
                        setSentNote(true);
                      }}
                    />
                  )}
                  {sentNote && !commenting && (
                    <div
                      role="status"
                      data-slot="browser-comment-sent"
                      className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/90 px-3 py-1.5 text-12 whitespace-nowrap text-surface shadow-md"
                    >
                      Sent to the agent
                    </div>
                  )}
                </div>
              </>
            )
          )}
        </ResizableDockSlide>
      )}
    </AnimatePresence>,
    dockLayer(),
  );
}

function BrowserTabs({
  chatKey,
  tabs,
  active,
  streamed,
  viewing,
  pages,
  onSelect,
  onCloseTab,
  onView,
  onClose,
}: {
  chatKey: string;
  tabs: BrowserTab[];
  active: string | null;
  streamed: ChatBrowserTargets;
  viewing: string | null;
  pages: Record<string, { title: string; url: string }>;
  onSelect: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onView: (targetId: string) => void;
  onClose: () => void;
}) {
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
              // A middle click closes the tab, as in a browser.
              onAuxClick={(event) => {
                if (event.button === 1) onCloseTab(tab.id);
              }}
              className={`group flex h-7 min-w-0 max-w-[180px] flex-1 basis-[140px] items-center gap-1.5 rounded-control pr-1 pl-2 text-12 ${selected ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover/60"}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                title={addressText(tab.url) || name}
                onClick={() => onSelect(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${name}`}
                onClick={() => onCloseTab(tab.id)}
                className={`flex size-5 shrink-0 items-center justify-center rounded-inline text-ink-3 hover:bg-hover hover:text-ink ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={12} aria-hidden />
              </button>
            </div>
          );
        })}
        {streamed.targets.map((target) => (
          <StreamedTab
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
      <Tooltip label="New page" side="bottom">
        <button type="button" aria-label="New page" onClick={() => addBlankTab(chatKey)} className={ICON_BUTTON}>
          <HugeiconsIcon icon={PlusSignIcon} size={15} aria-hidden />
        </button>
      </Tooltip>
      <Tooltip label="Hide Browser panel" shortcut={shortcutLabel(rules, "browser.toggle")} side="bottom" align="end">
        <button type="button" aria-label="Hide Browser panel" onClick={onClose} className={ICON_BUTTON}>
          <HugeiconsIcon icon={Cancel01Icon} size={15} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

const SOURCE_LABEL: Record<BrowserTarget["source"], string> = {
  agent: "Agent's browser",
  attached: "Attached",
  panel: "Its computer's panel",
};

/** A page the panel streams: the agent's own browser, an attached one or another computer's panel. */
function StreamedTab({
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
        <HugeiconsIcon icon={BrowserIcon} size={14} className="shrink-0 text-ink-3" aria-hidden />
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
            <HugeiconsIcon icon={Unlink04Icon} size={12} aria-hidden />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A streamed page's address, read only (the page's own controls are under it, in the stream), with the actions a page of
 * the panel's own has: comments on another computer's panel page, and opening the page in this Mac's browser.
 */
function ViewerToolbar({
  chatKey,
  target,
  page,
  commenting,
  onComment,
}: {
  chatKey: string;
  target: BrowserTarget;
  page?: { title: string; url: string };
  commenting: boolean;
  onComment: () => void;
}) {
  const url = page?.url || target.url;
  const { computers } = useComputers();
  const loopbackOnly = useContext(LoopbackPortsContext);
  const external = openablePageUrl(url, {
    remote: isRemoteKey(chatKey),
    host: computers.find((computer) => computer.id === computerOfKey(chatKey))?.address,
    loopbackOnly,
  });
  const commentLabel = commenting ? "Stop commenting" : "Comment on the page";
  const openLabel = external.href ? "Open in your default browser" : external.reason;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      <div
        data-slot="browser-viewer-address"
        title={`${target.source === "agent" ? target.browser : SOURCE_LABEL[target.source]} · ${url}`}
        className="mr-1 h-7 min-w-0 flex-1 truncate rounded-control border border-transparent bg-hover px-2.5 text-12 leading-7 text-ink-2"
      >
        {addressText(url)}
      </div>
      {target.source !== "panel" && (
        <span className="shrink-0 pr-1 text-11 text-ink-3">{target.source === "agent" ? target.browser : SOURCE_LABEL[target.source]}</span>
      )}
      {target.source === "panel" && (
        <Tooltip label={commentLabel} side="bottom" align="end">
          <button
            type="button"
            aria-label={commentLabel}
            aria-pressed={commenting}
            data-slot="browser-comment-toggle"
            onClick={onComment}
            className={`flex size-7 shrink-0 items-center justify-center rounded-control ${commenting ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
          >
            <HugeiconsIcon icon={CommentAdd01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
      )}
      <Tooltip label={openLabel} side="bottom" align="end">
        <button
          type="button"
          aria-label="Open in your default browser"
          data-slot="browser-viewer-open"
          disabled={!external.href}
          onClick={() => external.href && window.open(external.href, "_blank")}
          className={ICON_BUTTON}
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={15} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

function TabIcon({ tab }: { tab: BrowserTab }) {
  const [broken, setBroken] = useState(false);
  if (tab.loading) return <SpinnerRing size={12} />;
  if (tab.favicon && !broken) return <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-inline" onError={() => setBroken(true)} />;
  return <HugeiconsIcon icon={Globe02Icon} size={14} className="shrink-0 text-ink-3" aria-hidden />;
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
        className="h-7 min-w-0 flex-1 rounded-control border border-transparent bg-hover px-2.5 text-12 text-ink outline-none placeholder:text-ink-3 focus:border-line-strong focus:bg-surface"
      />
      <CommentControls chatKey={chatKey} live={!blank && !tab.error} onSend={onSendComments} />
      <Tooltip label="Open in your default browser" side="bottom" align="end">
        <button type="button" aria-label="Open in your default browser" disabled={blank} onClick={() => window.open(tab.url, "_blank")} className={ICON_BUTTON}>
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
          <button
            type="button"
            onClick={() => navigateBrowserTab(chatKey, tab.id, tab.url)}
            className="rounded-control border border-line px-3 py-1.5 text-12 text-ink hover:bg-hover"
          >
            Try again
          </button>
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
      <HugeiconsIcon icon={Globe02Icon} size={28} className="text-ink-3" aria-hidden />
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
                className="flex items-center gap-2 rounded-control px-3 py-2 text-left text-13 hover:bg-hover"
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

/** Browsers no Chat's agent started, on the Chat's computer. Attaching one streams its pages here, as tabs. */
function OtherBrowsers({ chatKey, streamed, onAttach }: { chatKey: string; streamed: ChatBrowserTargets; onAttach: (browserId: string) => void }) {
  return (
    <div className="flex w-full max-w-[300px] flex-col gap-1">
      <p className="mb-1 text-center text-12 text-ink-3">{isRemoteKey(chatKey) ? "Other browsers on its computer" : "Other browsers on this computer"}</p>
      {streamed.others.map((other: BrowserCandidate) => (
        <div key={other.id} data-browser-other={other.id} className="flex items-center gap-2 rounded-control px-3 py-1.5">
          <HugeiconsIcon icon={BrowserIcon} size={16} aria-hidden className="shrink-0 text-ink-3" />
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
              <HugeiconsIcon icon={Link01Icon} size={14} aria-hidden />
              Attach
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}
