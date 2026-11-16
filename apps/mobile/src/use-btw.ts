import { projectOfKey } from "@milagre/shared/agent-runs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BtwRequest, BtwState } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { Client } from "./client";

export function useBtw(client: Client | null, chatId: string | null | undefined, offline: boolean) {
  const [state, setState] = useState<BtwState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = useRef(chatId);
  useEffect(() => {
    active.current = chatId;
  }, [chatId]);
  useEffect(() => {
    if (!client || !chatId || offline) return;
    let cancelled = false;
    let sequence = 0;
    async function load() {
      const own = ++sequence;
      const next = await client!.call<BtwState | null>("chat:btw-read", [chatId]);
      if (!cancelled && own === sequence) setState(next);
    }
    const refresh = () => void load().catch(() => {});
    refresh();
    const live = client.live?.(projectOfKey(chatId), {
      onSignal: (signal) => {
        if (signal === "btw") refresh();
      },
      onStatus: (open) => {
        if (open) refresh();
      },
    });
    return () => {
      cancelled = true;
      live?.close();
    };
  }, [client, chatId, offline]);
  const ask = useCallback(
    async (request: Omit<BtwRequest, "chatId">) => {
      if (!client || !chatId || offline) return;
      setDismissed(null);
      if (!request.prompt.trim()) return;
      try {
        const next = await client.call<BtwState>("chat:btw", [{ ...request, chatId }]);
        if (active.current === chatId) setState((held) => (held?.requestId === next.requestId ? held : next));
      } catch (error) {
        if (active.current === chatId)
          setState({
            requestId: String(Date.now()),
            chatId,
            question: request.prompt,
            provider: request.provider ?? "claude",
            model: request.model ?? "",
            status: "failed",
            text: "",
            steps: [],
            error: ipcErrorMessage(error),
            startedAt: Date.now(),
          });
      }
    },
    [client, chatId, offline],
  );
  const stop = useCallback(() => {
    if (!client || !chatId || offline) return;
    async function stopQuestion() {
      const next = await client!.call<BtwState | null>("chat:btw-stop", [chatId]);
      if (active.current === chatId) setState(next);
    }
    void stopQuestion().catch(() => {});
  }, [client, chatId, offline]);
  const dismiss = useCallback(() => {
    if (state) setDismissed(state.requestId);
    stop();
  }, [state, stop]);
  return { state: state && state.chatId === chatId && state.requestId !== dismissed ? state : null, ask, stop, dismiss };
}
