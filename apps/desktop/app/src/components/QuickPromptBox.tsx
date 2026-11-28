import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { shortcutCommand } from "../lib/keybindings";
import { caretPoint, type ScreenPoint } from "../lib/orchestrator-board";
import { Attachments } from "./Attachments";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { useQuickImages, type QuickImage } from "./useQuickImages";

const MAX_HEIGHT = 160;

let measure: CanvasRenderingContext2D | null = null;
function charWidth(field: HTMLTextAreaElement) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 8;
  measure.font = getComputedStyle(field).font;
  return measure.measureText("abcdefghijklmnopqrstuvwxyz ").width / 27;
}

export type QuickSubmit<Result> = (text: string, images: QuickImage[], withMod: boolean) => Promise<Result>;

export function QuickPromptBox<Result>({
  submit,
  maxImages,
  label,
  placeholder,
  size = "compact",
  autoFocus = false,
  header,
  leading,
  onSent,
  onCaret,
  onEscape,
  hidden = false,
  focusSignal = 0,
  ref,
}: {
  submit: QuickSubmit<Result>;
  maxImages: number;
  label: string;
  placeholder: string;
  size?: "large" | "compact";
  autoFocus?: boolean;
  header?: ReactNode;
  leading?: ReactNode;
  onSent?: (result: Result, from: DOMRect, withMod: boolean) => void;
  onCaret?: (caret: ScreenPoint | null) => void;
  onEscape?: () => void;
  hidden?: boolean;
  focusSignal?: number;
  ref?: Ref<HTMLDivElement>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const attached = useQuickImages(maxImages);
  const large = size === "large";
  const empty = !text.trim() && !attached.images.length;

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
    if (!node || !onCaret) return;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    onCaret(
      caretPoint(node.value.slice(0, node.selectionStart ?? node.value.length), charWidth(node), {
        left: rect.left,
        top: rect.top - node.scrollTop,
        width: node.clientWidth,
        padLeft: parseFloat(style.paddingLeft) || 0,
        padTop: parseFloat(style.paddingTop) || 0,
        lineHeight: parseFloat(style.lineHeight) || 20,
      }),
    );
  };

  async function send(withMod: boolean) {
    const node = field.current;
    if (empty || sending || !node) return;
    const from = node.getBoundingClientRect();
    setSending(true);
    setError(null);
    try {
      const result = await submit(text.trim(), attached.images, withMod);
      setText("");
      attached.clear();
      onCaret?.(null);
      if (!withMod) node.blur();
      onSent?.(result, from, withMod);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
    if (withMod) requestAnimationFrame(() => field.current?.focus());
  }

  return (
    <div ref={ref} data-quick-prompt-box={size} className="flex flex-col gap-2" style={hidden ? { visibility: "hidden" } : undefined}>
      <div
        className="flex flex-col gap-2 rounded-window border border-line bg-surface p-3 shadow-raised"
        onDragOver={attached.onDragOver}
        onDrop={attached.onDrop}
      >
        {header}
        <div className="flex items-start gap-3">
          {leading}
          <textarea
            ref={field}
            rows={1}
            value={text}
            aria-label={label}
            placeholder={placeholder}
            disabled={sending}
            onChange={(event) => {
              setText(event.target.value);
              requestAnimationFrame(look);
            }}
            onPaste={attached.onPaste}
            onKeyUp={look}
            onClick={look}
            onFocus={look}
            onBlur={() => !text && onCaret?.(null)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (shortcutCommand(event.nativeEvent) === "chat.sendStay") {
                event.preventDefault();
                void send(true);
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(false);
              } else if (event.key === "Escape" && onEscape) {
                event.preventDefault();
                event.stopPropagation();
                onEscape();
              }
            }}
            className={`min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-3 ${large ? "min-h-8 text-15" : "min-h-5 text-13"}`}
          />
        </div>
        {attached.images.length > 0 && (
          <div className="-mb-2">
            <Attachments images={attached.images} removeImage={sending ? undefined : attached.remove} />
          </div>
        )}
        <div className="flex h-7 items-center justify-end">
          <button
            type="button"
            aria-label="Send"
            disabled={empty || sending}
            onClick={(event) => void send(event.metaKey || event.ctrlKey)}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink transition-[opacity,scale] duration-fast enabled:hover:opacity-90 enabled:active:scale-press disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon icon={ArrowUp02Icon} size={16} />
          </button>
        </div>
      </div>
      <InlineError size={12} className="px-1">
        {error || attached.error || null}
      </InlineError>
    </div>
  );
}
