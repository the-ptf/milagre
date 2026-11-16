import { Component, createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { Renderer } from "@milagre/shared/genui-renderer";
import type { ActionEvent, ParseResult } from "@milagre/shared/genui-renderer";
import { GENUI_ACTION_TYPE, genuiTextOverLimit } from "@milagre/shared/genui";
import { genuiLibrary } from "./library";
import { DISABLED_OPACITY } from "../primitives/press-style";

type Send = (text: string) => Promise<boolean | "busy">;
const SendContext = createContext<{ send?: Send }>({});

export function GenerativeUIProvider({ send, children }: { send?: Send; children: ReactNode }) {
  const value = useMemo(() => ({ send }), [send]);
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
  const { send } = useContext(SendContext);
  const [rootless, setRootless] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const onParseResult = useCallback((result: ParseResult | null) => setRootless(!result?.root || !!result.meta.incomplete), []);
  const onAction = useCallback(
    async (event: ActionEvent) => {
      if (event.type !== GENUI_ACTION_TYPE || !send || sending.current || !event.humanFriendlyMessage) return;
      sending.current = true;
      setBusy(true);
      try {
        await send(event.humanFriendlyMessage);
      } catch {
      } finally {
        sending.current = false;
        setBusy(false);
      }
    },
    [send],
  );
  if (genuiTextOverLimit(code)) return <>{fallback}</>;
  if (rootless && !streaming) return <>{fallback}</>;
  return (
    <Boundary fallback={fallback}>
      <View pointerEvents={busy ? "none" : "auto"} style={{ opacity: busy ? DISABLED_OPACITY.row : 1 }}>
        <Renderer response={code} library={genuiLibrary} isStreaming={streaming || busy || !send} onParseResult={onParseResult} onAction={onAction} />
      </View>
    </Boundary>
  );
}
