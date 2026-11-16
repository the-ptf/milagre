import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserApi, BrowserList } from "@milagre/shared/browser";
import { ipcErrorMessage } from "@milagre/shared/result";
import { isRemoteKey, onAnyAgentEvent, useBridge } from "../../lib/computer-bridge";
import { isTurnEnd } from "@milagre/shared/agent-runs";

const POLL_MS = 15_000;

export type ChatBrowserTargets = BrowserList & {
  api: BrowserApi | undefined;
  loading: boolean;
  attaching: string | null;
  attach(browserId: string): Promise<BrowserList | null>;
  detach(browserId: string): Promise<void>;
};

export function useChatBrowserTargets(chatId: string | null | undefined, active: boolean): ChatBrowserTargets {
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

export const targetBrowserId = (targetId: string) => targetId.slice(0, targetId.indexOf(":"));

function withoutOwnPanel(list: BrowserList, chatId: string | null | undefined): BrowserList {
  if (isRemoteKey(chatId)) return list;
  return { ...list, targets: list.targets.filter((target) => target.source !== "panel") };
}
