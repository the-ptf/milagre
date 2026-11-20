import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, MessageSquareQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { CHIP, ICON_SIZE } from "./PromptChip";
import Tooltip from "./primitives/Tooltip";
import { useSize } from "./motion/morph";

const TOOLTIP_CHARACTERS = 600;
const tooltipText = (text: string) => (text.length > TOOLTIP_CHARACTERS ? `${text.slice(0, TOOLTIP_CHARACTERS).trimEnd()}…` : text);

function QuoteChips({ quotes, onRemove }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void }) {
  return quotes.map((quote) => (
    <span
      key={quote.id}
      data-quote-chip
      data-source={quote.source}
      className={`${CHIP} group/quote max-w-[min(14rem,calc(100cqw-1rem))]! border-line-strong bg-hover pr-0.5 text-ink`}
    >
      <HugeiconsIcon icon={MessageSquareQuoteIcon} size={ICON_SIZE} strokeWidth={1.8} aria-hidden className="shrink-0 text-ink-2" />
      <Tooltip label={quote.source ? `${quote.source}: ${tooltipText(quote.text)}` : tooltipText(quote.text)} wrap className="flex min-w-0">
        <span data-quote-text className="truncate self-baseline">
          “{quote.text.replace(/\s+/g, " ").trim()}
        </span>
      </Tooltip>
      <button
        type="button"
        aria-label="Remove quote"
        onClick={() => onRemove(quote.id)}
        className="flex size-[1.2em] shrink-0 items-center justify-center rounded-inline text-ink-3 transition-colors duration-fast hover:bg-hover hover:text-ink"
      >
        <HugeiconsIcon icon={Cancel01Icon} size="0.8em" strokeWidth={2} aria-hidden />
      </button>
    </span>
  ));
}

const QUOTE_SPACER = "before:float-left before:mr-1.5 before:h-(--quote-h) before:w-(--quote-w) before:content-['']";

/** The composer's field with its quotes on the first line: the field's floated `spacer` keeps the text after and under them. */
export function QuotedField({
  quotes,
  onRemove,
  children,
}: {
  quotes: readonly ComposerQuote[];
  onRemove: (id: string) => void;
  children: (spacer: string) => ReactNode;
}) {
  const [box, boxRef] = useSize();
  const shown = quotes.length > 0;
  return (
    <div
      className="@container relative col-span-full row-start-1 min-w-0"
      style={shown && box ? ({ "--quote-w": `${box.width}px`, "--quote-h": `${box.height}px` } as CSSProperties) : undefined}
      onScrollCapture={(event) => {
        const overlay = event.currentTarget.querySelector<HTMLElement>("[data-quote-overlay]");
        if (overlay && event.target instanceof HTMLElement) overlay.style.translate = `0 ${-event.target.scrollTop}px`;
      }}
    >
      {children(shown ? QUOTE_SPACER : "")}
      {shown && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <span
            ref={boxRef}
            data-quote-overlay
            className="pointer-events-auto absolute top-2 left-2 inline-flex max-w-[calc(100%-1rem)] flex-wrap gap-x-1.5 gap-y-1 text-[length:calc(var(--chat-size)+1px)] leading-5 [&>[data-quote-chip]]:top-0"
          >
            <QuoteChips quotes={quotes} onRemove={onRemove} />
          </span>
        </div>
      )}
    </div>
  );
}

export function SentQuote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && !open) setClamped(element.scrollHeight > element.clientHeight + 1);
  }, [text, open]);
  const expandable = clamped || open;
  return (
    <div
      ref={ref}
      data-sent-quote
      role={expandable ? "button" : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? open : undefined}
      onClick={expandable ? () => window.getSelection()?.isCollapsed !== false && setOpen((current) => !current) : undefined}
      onKeyDown={
        expandable
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              setOpen((current) => !current);
            }
          : undefined
      }
      className={`border-l-2 border-line-strong pl-2 text-12 leading-[1.45] break-words whitespace-pre-wrap text-ink-3 [overflow-wrap:anywhere] ${open ? "" : "line-clamp-3"} ${expandable ? "cursor-pointer" : ""}`}
    >
      {text}
    </div>
  );
}
