import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { caretLook } from "../../lib/orchestrator-board";
import { sendOrchestratorTask } from "../../lib/orchestrator-store";
import { IconButton } from "../primitives/Button";
import { InlineError } from "../primitives/InlineError";
import type { Look } from "./Mascot";

const MAX_HEIGHT = 160;

let measure: CanvasRenderingContext2D | null = null;
function charWidth(field: HTMLTextAreaElement) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 8;
  measure.font = getComputedStyle(field).font;
  return measure.measureText("abcdefghijklmnopqrstuvwxyz ").width / 27;
}

export function OrchestratorBox({
  size = "large",
  placeholder = "Ask for anything, in any Project…",
  autoFocus = false,
  leading,
  onSent,
  onLook,
  onEscape,
  hidden = false,
  focusSignal = 0,
  ref,
}: {
  size?: "large" | "compact";
  placeholder?: string;
  autoFocus?: boolean;
  leading?: ReactNode;
  onSent?: (task: OrchestratorTask, from: DOMRect) => void;
  onLook?: (look: Look) => void;
  onEscape?: () => void;
  hidden?: boolean;
  focusSignal?: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const large = size === "large";
  const empty = !text.trim();

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus || focusSignal) field.current?.focus();
  }, [autoFocus, focusSignal]);

  const look = () => {
    const node = field.current;
    if (!node || !onLook) return;
    onLook(caretLook(node.value.slice(0, node.selectionStart ?? node.value.length), charWidth(node), node.clientWidth));
  };

  async function send() {
    const node = field.current;
    if (empty || sending || !node) return;
    const from = node.getBoundingClientRect();
    setSending(true);
    setError(null);
    try {
      const task = await sendOrchestratorTask(text.trim());
      setText("");
      onLook?.(null);
      node.blur();
      onSent?.(task, from);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div ref={ref} data-orchestrator-box={size} className="flex flex-col gap-2" style={hidden ? { visibility: "hidden" } : undefined}>
      <div className={`flex flex-col gap-2 rounded-window bg-surface shadow-raised ${large ? "px-4 pt-3 pb-2" : "px-3 pt-2.5 pb-2"}`}>
        <div className="flex items-start gap-3">
          {leading}
          <textarea
            ref={field}
            rows={large ? 2 : 1}
            value={text}
            aria-label="What should the Orchestrator do?"
            placeholder={placeholder}
            disabled={sending}
            onChange={(event) => {
              setText(event.target.value);
              requestAnimationFrame(look);
            }}
            onKeyUp={look}
            onClick={look}
            onFocus={look}
            onBlur={() => !text && onLook?.(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape" && onEscape) {
                event.preventDefault();
                event.stopPropagation();
                onEscape();
              }
            }}
            className={`min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-3 ${large ? "min-h-11 text-15" : "min-h-5 text-13"}`}
          />
        </div>
        <div className="flex h-7 items-center justify-end">
          <IconButton
            size={28}
            shape="pill"
            variant="primary"
            label="Send"
            shortcut="Enter"
            icon={ArrowUp02Icon}
            disabled={empty || sending}
            onClick={() => void send()}
          />
        </div>
      </div>
      <InlineError size={12} className="px-1">
        {error}
      </InlineError>
    </div>
  );
}
