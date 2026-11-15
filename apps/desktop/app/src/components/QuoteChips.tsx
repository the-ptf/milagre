import { useLayoutEffect, useRef, useState } from "react";
import { Cancel01Icon, MessageSquareQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { Icon } from "./primitives/Icon";
import Tooltip from "./primitives/Tooltip";

// A tooltip shows a long quote's start; the message carries all of it.
const TOOLTIP_CHARACTERS = 600;
const tooltipText = (text: string) => (text.length > TOOLTIP_CHARACTERS ? `${text.slice(0, TOOLTIP_CHARACTERS).trimEnd()}…` : text);

/**
 * The passages quoted into the next message, in the order they were added: a pill each in the attachments row, like an
 * image's tile, reading “the passage's start…. The tooltip names where it came from and shows more.
 */
export function QuoteChips({ quotes, onRemove }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void }) {
  return quotes.map((quote) => {
    const text = quote.text.replace(/\s+/g, " ").trim();
    return (
      <div
        key={quote.id}
        data-quote-chip
        data-source={quote.source}
        className="relative flex h-8 max-w-60 min-w-0 items-center gap-1.5 rounded-control border border-line bg-inset pr-3 pl-2.5 text-13 text-ink"
      >
        <Icon icon={MessageSquareQuoteIcon} size={16} className="shrink-0 text-ink-2" />
        <Tooltip label={quote.source ? `${quote.source}: ${tooltipText(quote.text)}` : tooltipText(quote.text)} wrap className="flex min-w-0">
          <span data-quote-text className="min-w-0 truncate">
            “{text}
          </span>
        </Tooltip>
        <button
          type="button"
          aria-label="Remove quote"
          onClick={() => onRemove(quote.id)}
          className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-ink transition-colors duration-fast before:absolute before:-inset-0.5 hover:bg-hover"
        >
          <Icon icon={Cancel01Icon} size={12} />
        </button>
      </div>
    );
  });
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
