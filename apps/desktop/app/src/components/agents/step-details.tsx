import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMessage, ChatStep } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";

// state the windows receive stays small. Opening such a step reads its message once from the host.

const ScopeContext = createContext<string | null>(null);
const MessageContext = createContext<number | null>(null);

export function StepDetailsScope({ scope, children }: { scope: string | undefined; children: ReactNode }) {
  return <ScopeContext.Provider value={scope ?? null}>{children}</ScopeContext.Provider>;
}

export function StepDetailsMessage({ id, children }: { id: number; children: ReactNode }) {
  return <MessageContext.Provider value={id > 0 ? id : null}>{children}</MessageContext.Provider>;
}

const LIMIT = 20;
const loaded = new Map<string, Promise<ChatMessage>>();
function loadMessage(scope: string, id: number) {
  const key = `${scope}#${id}`;
  let message = loaded.get(key);
  if (!message) {
    message = bridgeForKey(scope).getMessage(scope, id);
    message.catch(() => loaded.delete(key));
    loaded.set(key, message);
    if (loaded.size > LIMIT) loaded.delete(loaded.keys().next().value!);
  }
  return message;
}

export type StepDetail = { detail?: string; loading: boolean; failed: boolean; retry: () => void };

export function useStepDetail(step: ChatStep, open: boolean): StepDetail {
  const scope = useContext(ScopeContext);
  const messageId = useContext(MessageContext);
  const remote = !step.detail && Boolean(step.hasDetail) && scope !== null && messageId !== null;
  const [read, setRead] = useState<{ id: string; detail?: string; failed: boolean } | null>(null);
  const retry = useCallback(() => setRead(null), []);
  useEffect(() => {
    if (!open || !remote || read?.id === step.id) return;
    let cancelled = false;
    loadMessage(scope!, messageId!).then(
      (message) => {
        const detail = message.steps?.find((item) => item.id === step.id)?.detail;
        if (!cancelled) setRead({ id: step.id, detail, failed: detail === undefined });
      },
      () => {
        if (!cancelled) setRead({ id: step.id, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, remote, scope, messageId, step.id, read?.id]);
  if (!remote) return { detail: step.detail, loading: false, failed: false, retry };
  if (read?.id !== step.id) return { loading: open, failed: false, retry };
  return { detail: read.detail, loading: false, failed: read.failed, retry };
}

export function useHasStepDetail(step: ChatStep) {
  const scope = useContext(ScopeContext);
  const messageId = useContext(MessageContext);
  return Boolean(step.input) || Boolean(step.detail) || (Boolean(step.hasDetail) && scope !== null && messageId !== null);
}
