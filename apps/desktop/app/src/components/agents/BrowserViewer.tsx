import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserApi, BrowserInput, BrowserList } from "@milagre/shared/browser";
import { createBrowserBridge, createBrowserReceiverHtml } from "@milagre/shared/browser-receiver";
import { ipcErrorMessage } from "@milagre/shared/result";
import { viewerTheme } from "./viewerTheme";
import { isRemoteKey, onAnyAgentEvent, useBridge } from "../../lib/computer-bridge";
import { isTurnEnd } from "@milagre/shared/agent-runs";

const POLL_MS = 15_000;

export type ChatBrowserTargets = BrowserList & {
  api: BrowserApi | undefined;
  loading: boolean;
  /** The browser being attached or detached. */
  attaching: string | null;
  attach(browserId: string): Promise<BrowserList | null>;
  detach(browserId: string): Promise<void>;
};

/**
 * Pages the Browser panel streams rather than loads: those of browsers this Chat's agent started, of browsers attached
 * to this Chat, and a Chat on another computer's own panel pages. Never inferred from a URL. `active` (the panel on
 * show) keeps the list polled while there is no page yet.
 */
export function useChatBrowserTargets(chatId: string | null | undefined, active: boolean): ChatBrowserTargets {
  // Read once: the bridge never changes while mounted, and a fresh reference each render would restart polling.
  const bridge = useBridge();
  const [api] = useState(() => bridge?.browsers);
  const [list, setList] = useState<BrowserList>({ supported: true, targets: [], others: [] });
  const [attaching, setAttaching] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!api || !chatId || document.hidden) return;
    try {
      const next = await api.list({ chatId });
      if (mounted.current) setList(withoutOwnPanel(next, chatId));
    } catch (error) {
      if (mounted.current) setList((current) => ({ ...current, error: ipcErrorMessage(error) }));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api, chatId]);
  // The list read, for the poll below; a no-op while unmounted.
  const pollList = useRef<() => Promise<void>>(async () => {});
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
      if (!document.hidden) void poll();
    };
    pollList.current = poll;
    void poll();
    document.addEventListener("visibilitychange", visibility);
    // With no page nothing is polled (the list spawns a process on the host): a page comes from the Chat's agent, a
    // browser its commands start or one it attaches, so its steps finishing (at most once per POLL_MS) and each turn's
    // end read the list again; so does coming back to the window, after one was attached from the phone.
    const focused = () => void poll();
    window.addEventListener("focus", focused);
    let readAt = 0;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      clearTimeout(soon);
      soon = undefined;
      readAt = Date.now();
      void poll();
    };
    const offAgent = onAnyAgentEvent(({ chatId: from, event }) => {
      if (from !== chatId) return;
      if (isTurnEnd(event)) read();
      else if (event.type === "step-completed" && !soon) soon = setTimeout(read, Math.max(0, readAt + POLL_MS - Date.now()));
    });
    return () => {
      clearTimeout(soon);
      pollList.current = async () => {};
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focused);
      offAgent();
    };
  }, [api, chatId, refresh]);
  // While the Chat has a page, the panel shows or a browser is being attached, the list is polled: pages open, close
  // and navigate on their own.
  const polling = !!api && !!chatId && (list.targets.length > 0 || active || attaching !== null);
  useEffect(() => {
    if (!polling) return;
    void pollList.current();
    const timer = setInterval(() => void pollList.current(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);
  const change = async (browserId: string, method: "attach" | "detach") => {
    if (!api || !chatId) return null;
    setAttaching(browserId);
    try {
      const next = withoutOwnPanel(await api[method]({ chatId, browserId }), chatId);
      if (mounted.current) setList(next);
      return next;
    } catch (error) {
      if (mounted.current) setList((current) => ({ ...current, error: ipcErrorMessage(error) }));
      return null;
    } finally {
      if (mounted.current) setAttaching(null);
    }
  };
  const supported = !!api && !!chatId && list.supported;
  return {
    ...list,
    targets: supported ? list.targets : [],
    others: supported ? list.others : [],
    api,
    loading: supported && loading,
    attaching,
    attach: (browserId) => change(browserId, "attach"),
    detach: async (browserId) => void (await change(browserId, "detach")),
  };
}

/** The browser a target id (`<browserId>:<pageId>`) belongs to. */
export const targetBrowserId = (targetId: string) => targetId.slice(0, targetId.indexOf(":"));

/** A point picked on a streamed page: fractions of the page, and where it shows in the viewer, in its CSS pixels. */
export type StreamedPoint = { x: number; y: number; left: number; top: number; viewport: { width: number; height: number } };

/**
 * A streamed page: frames from the host, with input sent back. Mounted only while on show, so hiding it ends the capture.
 * While `commenting`, a click picks a point (onPick) instead of clicking the page, and Escape (onEscape) ends it; a
 * wheel still scrolls the page until a point is picked, which then shows its pin.
 */
export function BrowserViewerFrame({
  api,
  chatId,
  targetId,
  onPage,
  commenting = false,
  picked = null,
  onPick,
  onEscape,
}: {
  api: BrowserApi;
  chatId: string;
  targetId: string;
  onPage(page: { title: string; url: string }): void;
  commenting?: boolean;
  picked?: { x: number; y: number } | null;
  onPick?(point: StreamedPoint): void;
  onEscape?(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The newest props, read by the bridge, so new ones each render don't restart the viewer.
  const latest = useRef({ onPage, commenting, picked, onPick, onEscape });
  useEffect(() => {
    latest.current = { onPage, commenting, picked, onPick, onEscape };
  });
  // The receiver draws the pin (same origin: a srcdoc frame).
  const syncPin = useCallback(
    () =>
      (frame.current?.contentWindow as (Window & { browserCommentPoint?(point: { x: number; y: number } | null): void }) | null)?.browserCommentPoint?.(
        latest.current.picked,
      ),
    [],
  );
  useEffect(syncPin, [picked, syncPin]);
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
      (method, args) => {
        const event = method === "input" ? (args as { event?: BrowserInput }).event : undefined;
        if (event && latest.current.commenting) {
          // A click names the comment's point and the page never gets it; keys stay here too, Escape ending comment mode.
          if (event.kind === "mouse") {
            if (event.phase === "up") pick(event.x, event.y);
            return Promise.resolve({ accepted: true });
          }
          if (event.kind === "key" || event.kind === "text") {
            if (event.kind === "key" && event.phase === "down" && event.key === "Escape") latest.current.onEscape?.();
            return Promise.resolve({ accepted: true });
          }
          // The point stays where it was picked while its comment is written.
          if (event.kind === "wheel" && latest.current.picked) return Promise.resolve({ accepted: true });
        }
        return (api[method] as (request: unknown) => Promise<unknown>)(args).catch((error) => {
          throw new Error(ipcErrorMessage(error));
        });
      },
      (reply) => frame.current?.contentWindow?.postMessage(reply, "*"),
    );
    const pick = (x: number, y: number) => {
      const view = frame.current?.getBoundingClientRect();
      const image = frame.current?.contentDocument?.getElementById("frame")?.getBoundingClientRect();
      if (!view || !image) return;
      latest.current.onPick?.({
        x,
        y,
        left: image.left + x * image.width,
        top: image.top + y * image.height,
        viewport: { width: view.width, height: view.height },
      });
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== "milagre-browser") return;
      // Escape asks to close the viewer; the panel stays, as it does for its own pages.
      if (event.data.event === "close") return;
      if (event.data.event === "page") {
        latest.current.onPage({ title: String(event.data.title ?? ""), url: String(event.data.url ?? "") });
        return;
      }
      void bridge.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      bridge.dispose();
    };
  }, [api, targetId]);
  return (
    <iframe
      ref={frame}
      onLoad={() => {
        syncTheme();
        syncPin();
      }}
      title="Live browser page"
      data-slot="browser-frame"
      srcDoc={html}
      // oxlint-disable-next-line react/iframe-missing-sandbox -- same receiver setup as the simulator viewer, flagged for review there
      sandbox="allow-scripts allow-same-origin"
      className="absolute inset-0 size-full border-0 bg-surface"
    />
  );
}

/**
 * This Mac's own Browser panel pages are in the panel already as webviews; they stream only for a Chat on another
 * computer, whose panel this window doesn't show. The phone lists them all.
 */
function withoutOwnPanel(list: BrowserList, chatId: string | null | undefined): BrowserList {
  if (isRemoteKey(chatId)) return list;
  return { ...list, targets: list.targets.filter((target) => target.source !== "panel") };
}
