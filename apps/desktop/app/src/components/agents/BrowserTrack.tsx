import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowExpand01Icon, ArrowShrink01Icon, BrowserIcon, Cancel01Icon, Link01Icon, Unlink04Icon } from "@hugeicons/core-free-icons";
import type { BrowserApi, BrowserList, BrowserTarget } from "@milagre/shared/browser";
import { createBrowserBridge, createBrowserReceiverHtml } from "@milagre/shared/browser-receiver";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { PillMorph } from "../motion/PillMorph";
import { viewerTheme } from "./viewerTheme";
import { useBridge } from "../../lib/computer-bridge";

/** Pages of browsers this Chat's agent started, or that were attached to this Chat. Never inferred from a URL. Hidden until the Chat has a page. */
export function BrowserTrack({ chatId }: { chatId?: string }) {
  // Read once: the bridge never changes while mounted, and a fresh reference each render would restart polling.
  const bridge = useBridge();
  const [api] = useState(() => bridge?.browsers);
  const [list, setList] = useState<BrowserList>({ supported: true, targets: [], others: [] });
  const [opened, setOpened] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<BrowserTarget | null>(null);
  const [page, setPage] = useState<{ title: string; url: string } | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = useCallback(() => {
    setOpened(false);
    setExpanded(false);
    setSelected(null);
    setPage(null);
  }, []);
  const refresh = useCallback(async () => {
    if (!api || !chatId || document.hidden) return;
    try {
      const next = await api.list({ chatId });
      if (mounted.current) setList(next);
    } catch (error) {
      if (mounted.current) setList((current) => ({ ...current, error: ipcErrorMessage(error) }));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api, chatId]);
  useEffect(() => {
    if (!api || !chatId) return;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        await refresh();
      } finally {
        busy = false;
      }
    };
    const visibility = () => {
      if (document.hidden) close();
      else void poll();
    };
    void poll();
    const timer = setInterval(poll, 15000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [api, chatId, close, refresh]);
  const visible = !!api && !!chatId && list.supported && list.targets.length > 0;
  const open = () => {
    setSelected(list.targets.length === 1 ? (list.targets[0] ?? null) : null);
    setOpened(true);
    void refresh();
  };
  const attach = async (browserId: string) => {
    if (!api || !chatId) return;
    setAttaching(browserId);
    try {
      const next = await api.attach({ chatId, browserId });
      if (mounted.current) setList(next);
    } catch (error) {
      if (mounted.current) setList((current) => ({ ...current, error: ipcErrorMessage(error) }));
    } finally {
      if (mounted.current) setAttaching(null);
    }
  };
  const detach = async (browserId: string) => {
    if (!api || !chatId) return;
    setAttaching(browserId);
    try {
      const next = await api.detach({ chatId, browserId });
      if (mounted.current) {
        setList(next);
        if (selected && selected.id.startsWith(`${browserId}:`)) {
          setSelected(null);
          setPage(null);
        }
      }
    } catch (error) {
      if (mounted.current) setList((current) => ({ ...current, error: ipcErrorMessage(error) }));
    } finally {
      if (mounted.current) setAttaching(null);
    }
  };
  const choosing = list.targets.length > 1 || list.others.length > 0;
  const shown = selected ? (page ?? { title: selected.title, url: selected.url }) : null;
  const content = api && chatId && (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        {selected && choosing ? (
          <Tooltip label="Back to pages">
            <button
              type="button"
              aria-label="Back to pages"
              onClick={() => {
                setSelected(null);
                setPage(null);
                void refresh();
              }}
              className="rounded p-1 text-ink-2 hover:bg-hover"
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={16} aria-hidden />
            </button>
          </Tooltip>
        ) : (
          <HugeiconsIcon icon={BrowserIcon} size={16} aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px]">{shown?.title || "Browser"}</div>
          <div className="truncate text-[11px] text-ink-3">{shown?.url || "This Chat"}</div>
        </div>
        {selected && (
          <Tooltip label={expanded ? "Collapse browser" : "Expand browser"}>
            <button
              type="button"
              aria-label={expanded ? "Collapse browser" : "Expand browser"}
              onClick={() => setExpanded((value) => !value)}
              className="rounded p-1 text-ink-2 hover:bg-hover"
            >
              <HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={16} aria-hidden />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Close browser">
          <button type="button" aria-label="Close browser" onClick={close} className="rounded p-1 text-ink-2 hover:bg-hover">
            <HugeiconsIcon icon={Cancel01Icon} size={16} aria-hidden />
          </button>
        </Tooltip>
      </header>
      {selected ? (
        <BrowserFrame key={selected.id} api={api} chatId={chatId} targetId={selected.id} onPage={setPage} onClose={close} />
      ) : (
        <ScrollArea className="p-1">
          {loading && (
            <p role="status" className="p-3 text-[13px] text-ink-2">
              Finding browser pages...
            </p>
          )}
          {list.error && (
            <p role="alert" className="p-3 text-[13px] text-red">
              {list.error}
            </p>
          )}
          {!loading && !list.error && !list.targets.length && (
            <p className="p-3 text-[13px] text-ink-2">This Chat's agent has no open pages. Attach a browser below to view it here.</p>
          )}
          {list.targets.map((target) => (
            <div key={target.id} className="flex items-center gap-1">
              <button
                type="button"
                data-browser-target={target.id}
                onClick={() => setSelected(target)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-hover"
              >
                <HugeiconsIcon icon={BrowserIcon} size={16} aria-hidden className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{target.title || target.url}</span>
                  <span className="block truncate text-[11px] text-ink-3">{target.url}</span>
                </span>
                <span className="shrink-0 text-[11px] text-ink-3">{target.source === "attached" ? "Attached" : target.browser}</span>
              </button>
              {target.source === "attached" && (
                <Tooltip label="Detach this browser from this Chat">
                  <button
                    type="button"
                    aria-label={`Detach ${target.title || target.url} from this Chat`}
                    data-browser-detach={target.id.slice(0, target.id.indexOf(":"))}
                    disabled={attaching !== null}
                    onClick={() => void detach(target.id.slice(0, target.id.indexOf(":")))}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover disabled:opacity-40"
                  >
                    <HugeiconsIcon icon={Unlink04Icon} size={14} aria-hidden />
                  </button>
                </Tooltip>
              )}
            </div>
          ))}
          {list.others.length > 0 && (
            <>
              <h3 className="px-3 pb-1 pt-3 text-[11px] font-medium text-ink-3">Other browsers on this computer</h3>
              {list.others.map((other) => (
                <div key={other.id} data-browser-other={other.id} className="flex items-center gap-2 rounded-md px-3 py-2">
                  <HugeiconsIcon icon={BrowserIcon} size={16} aria-hidden className="shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{other.title || other.browser}</span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {other.browser} · {other.pages} {other.pages === 1 ? "page" : "pages"}
                    </span>
                  </span>
                  <Tooltip label="Show this browser's pages in this Chat">
                    <button
                      type="button"
                      aria-label={`Attach ${other.title || other.browser} to this Chat`}
                      disabled={attaching !== null}
                      onClick={() => void attach(other.id)}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-ink-2 hover:bg-hover disabled:opacity-40"
                    >
                      <HugeiconsIcon icon={Link01Icon} size={14} aria-hidden />
                      Attach
                    </button>
                  </Tooltip>
                </div>
              ))}
            </>
          )}
        </ScrollArea>
      )}
    </>
  );
  return (
    <PillMorph
      shown={visible}
      slot="browser-track"
      panelSlot="browser-popover"
      title="Browser"
      tooltip="Browser pages this Chat's agent uses"
      opened={opened}
      expanded={expanded}
      onOpenChange={(next) => (next ? open() : close())}
      width={520}
      height={selected ? 600 : 360}
      fill={!!selected}
      pill={{
        icon: BrowserIcon,
        label: "Browser",
        count: list.targets.length,
        "aria-label": `Browser, ${list.targets.length} ${list.targets.length === 1 ? "page" : "pages"} in this Chat`,
      }}
    >
      {/* The viewer is mounted only while it is on show, so closing ends the capture. Expanded, the same surface fills the
      window, so the live page keeps its connection. */}
      {opened && content}
    </PillMorph>
  );
}

function BrowserFrame({
  api,
  chatId,
  targetId,
  onPage,
  onClose,
}: {
  api: BrowserApi;
  chatId: string;
  targetId: string;
  onPage(page: { title: string; url: string }): void;
  onClose(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => createBrowserReceiverHtml({ chatId, targetId, theme: viewerTheme() }), [chatId, targetId]);
  const syncTheme = useCallback(() => frame.current?.contentWindow?.postMessage({ channel: "milagre-browser-theme", theme: viewerTheme() }, "*"), []);
  useEffect(() => {
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [syncTheme]);
  useEffect(() => {
    // The receiver shows host errors to the user, without Electron's IPC prefix.
    const bridge = createBrowserBridge(
      (method, args) =>
        (api[method] as (request: unknown) => Promise<unknown>)(args).catch((error) => {
          throw new Error(ipcErrorMessage(error));
        }),
      (reply) => frame.current?.contentWindow?.postMessage(reply, "*"),
    );
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== "milagre-browser") return;
      if (event.data.event === "close") {
        onClose();
        return;
      }
      if (event.data.event === "page") {
        onPage({ title: String(event.data.title ?? ""), url: String(event.data.url ?? "") });
        return;
      }
      void bridge.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      bridge.dispose();
    };
  }, [api, targetId, onClose, onPage]);
  return (
    <iframe
      ref={frame}
      onLoad={syncTheme}
      title="Live browser page"
      data-slot="browser-frame"
      srcDoc={html}
      // oxlint-disable-next-line react/iframe-missing-sandbox -- same receiver setup as the simulator viewer, flagged for review there
      sandbox="allow-scripts allow-same-origin"
      className="min-h-0 w-full flex-1 border-0 bg-surface"
    />
  );
}
