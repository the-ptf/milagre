import { useLayoutEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, MessageSquareQuoteIcon } from "@hugeicons/core-free-icons";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import { CHIP, ICON_SIZE } from "./PromptChip";
import Tooltip from "./primitives/Tooltip";

// A tooltip shows a long quote's start; the message carries all of it.
const TOOLTIP_CHARACTERS = 600;
const tooltipText = (text: string) => (text.length > TOOLTIP_CHARACTERS ? `${text.slice(0, TOOLTIP_CHARACTERS).trimEnd()}…` : text);

/**
 * The passages quoted into the next message, in the order they were added: chips at the start of the prompt's line, in
 * the text's own size like an image's chip, each reading “the passage's start…. The tooltip names where it came from.
 */
export function QuoteChips({ quotes, onRemove }: { quotes: readonly ComposerQuote[]; onRemove: (id: string) => void }) {
  return quotes.map((quote) => (
    <span
      key={quote.id}
      data-quote-chip
      data-source={quote.source}
      className={`${CHIP} group/quote max-w-[min(14rem,100%)]! border-line-strong bg-hover pr-0.5 text-ink`}
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
