import { useEffect, useRef, useState } from "react";
import type { BtwRequest, BtwState } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "./computer-bridge";
import { useEvent } from "./stable";

export function useBtw(chatId: string | null) {
  const [state, setState] = useState<BtwState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = useRef(chatId);
  useEffect(() => {
    active.current = chatId;
  }, [chatId]);
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    let received = false;
    const receive = (payload: { chatId: string; btw: BtwState | null }) => {
      if (cancelled || payload.chatId !== chatId) return;
      received = true;
      setState(payload.btw);
    };
    const off = bridgeForKey(chatId).onBtwEvent?.(receive);
    async function load() {
      const next = await bridgeForKey(chatId).readBtw(chatId!);
      if (!cancelled && !received) setState(next);
    }
    void load().catch(() => {});
    return () => {
      cancelled = true;
      off?.();
    };
  }, [chatId]);
  const ask = useEvent(async (request: Omit<BtwRequest, "chatId">) => {
    if (!chatId) return;
    setDismissed(null);
    if (!request.prompt.trim()) return;
    const pendingId = crypto.randomUUID();
    setState({
      requestId: pendingId,
      chatId,
      question: request.prompt,
      provider: request.provider ?? "claude",
      model: request.model ?? "",
      status: "running",
      text: "",
      steps: [],
      startedAt: Date.now(),
    });
    try {
      const next = await bridgeForKey(chatId).askBtw({ ...request, chatId });
      if (active.current === chatId) setState((held) => (held?.requestId === next.requestId ? held : next));
    } catch (error) {
      if (active.current === chatId)
        setState((held) => (held?.requestId === pendingId ? { ...held, status: "failed", error: ipcErrorMessage(error), endedAt: Date.now() } : held));
    }
  });
  const stop = useEvent(() => {
    if (chatId)
      void bridgeForKey(chatId)
        .stopBtw(chatId)
        .catch(() => {});
  });
  const dismiss = useEvent(() => {
    if (state) setDismissed(state.requestId);
    stop();
  });
  return { state: state?.chatId === chatId && state.requestId !== dismissed ? state : null, ask, stop, dismiss };
}
