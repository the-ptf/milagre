import { Component, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Renderer } from "@milagre/shared/genui-renderer";
import type { ActionEvent, ParseResult } from "@milagre/shared/genui-renderer";
import { GENUI_ACTION_TYPE, genuiTextOverLimit } from "@milagre/shared/genui";
import { genuiLibrary } from "./library";

type Send = (text: string) => Promise<boolean>;
const SendContext = createContext<{ onSend?: Send }>({});

export function GenerativeUIProvider({ onSend, children }: { onSend?: Send; children: ReactNode }) {
  const value = useMemo(() => ({ onSend }), [onSend]);
  return <SendContext value={value}>{children}</SendContext>;
}

export const MarkdownStreamingContext = createContext(false);

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function GenerativeUI({ code, fallback }: { code: string; fallback: ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext);
  const { onSend } = useContext(SendContext);
  const [rootless, setRootless] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const onParseResult = useCallback((result: ParseResult | null) => setRootless(!result?.root || !!result.meta.incomplete), []);
  const onAction = useCallback(
    async (event: ActionEvent) => {
      if (event.type !== GENUI_ACTION_TYPE || !onSend || sending.current || !event.humanFriendlyMessage) return;
      sending.current = true;
      setBusy(true);
      try {
        await onSend(event.humanFriendlyMessage);
      } catch {
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
    [onSend],
  );
  if (genuiTextOverLimit(code)) return <>{fallback}</>;
  const empty = rootless && !streaming;
  return (
    <Boundary fallback={fallback}>
      {empty && fallback}
      <div data-slot={empty ? undefined : "genui"} hidden={empty} className="my-2">
        <Renderer response={code} library={genuiLibrary} isStreaming={streaming || busy || !onSend} onParseResult={onParseResult} onAction={onAction} />
      </div>
    </Boundary>
  );
}
