import { useLayoutEffect, useRef, useState } from "react";
import { Cancel01Icon, LeftToRightBlockQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { Icon } from "./primitives/Icon";
import { ScrollArea } from "./primitives/ScrollArea";
import Tooltip from "./primitives/Tooltip";

// A tooltip shows a long quote's start; the message carries all of it.
const TOOLTIP_CHARACTERS = 600;
const tooltipText = (text: string) => (text.length > TOOLTIP_CHARACTERS ? `${text.slice(0, TOOLTIP_CHARACTERS).trimEnd()}…` : text);

/** The passages quoted into the next message, one row each in the order they were added, over the prompt. */
export function QuoteChips({ quotes, onRemove }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void }) {
  if (!quotes.length) return null;
  return (
    <ScrollArea as="ul" chainScroll aria-label="Quotes" className="flex max-h-30 flex-col gap-1">
      {quotes.map((quote) => (
        <li key={quote.id} data-quote-chip className="flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-control bg-inset pr-1 pl-2.5 text-12 text-ink-2">
          <Icon icon={LeftToRightBlockQuoteIcon} size={14} className="shrink-0 text-ink-3" />
          <Tooltip label={tooltipText(quote.text)} wrap className="min-w-0 flex-1">
            <span className="min-w-0 flex-1 truncate">{quote.text.replace(/\s+/g, " ")}</span>
          </Tooltip>
          {quote.source && <span className="shrink-0 text-11 text-ink-3">{quote.source}</span>}
          <button
            type="button"
            aria-label="Remove quote"
            onClick={() => onRemove(quote.id)}
            className="flex size-6 shrink-0 items-center justify-center rounded-inline text-ink-3 transition-colors duration-fast hover:bg-hover hover:text-ink"
          >
            <Icon icon={Cancel01Icon} size={12} />
          </button>
        </li>
      ))}
    </ScrollArea>
  );
}

/** A quote at the head of a sent message: a bar and muted text, three lines until clicked open. */
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
      // A drag that selects part of the quote keeps it as it is.
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
