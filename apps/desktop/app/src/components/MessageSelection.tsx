import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { composerQuote, quoteSource, type ComposerQuote } from "@milagre/shared/prompt-parts";
import { shortcutCommand, useShortcutLabel } from "../lib/keybindings";

type Passage = { text: string; source: string; left: number; top: number };

function typedText(range: Range) {
  const fragment = range.cloneContents();
  const tokens = fragment.querySelectorAll("[data-token]");
  if (!tokens.length) return null;
  for (const token of tokens) token.replaceWith(token.getAttribute("data-token") ?? "");
  return fragment.textContent;
}

const element = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement);

function quotableRange(range: Range) {
  const root = element(range.startContainer)?.closest("[data-quotable]") ?? element(range.endContainer)?.closest("[data-quotable]");
  if (!root) return null;
  const inside = range.cloneRange();
  if (!root.contains(inside.startContainer)) inside.setStart(root, 0);
  if (!root.contains(inside.endContainer)) inside.setEnd(root, root.childNodes.length);
  return inside.toString().trim() === range.toString().trim() ? { root, inside } : null;
}

export function MessageSelection({
  container,
  provider,
  onQuote,
}: {
  container: RefObject<HTMLElement | null>;
  provider?: string;
  onQuote: (quote: ComposerQuote) => void;
}) {
  const [passage, setPassage] = useState<Passage | null>(null);
  const shortcut = useShortcutLabel("chat.quote");
  const latest = useRef({ passage, provider, onQuote });
  useLayoutEffect(() => {
    latest.current = { passage, provider, onQuote };
  });
  const quote = useCallback(() => {
    const shown = latest.current.passage;
    const made = shown && composerQuote(shown.text, shown.source);
    if (made) latest.current.onQuote(made);
    window.getSelection()?.removeAllRanges();
    setPassage(null);
  }, []);
  useEffect(() => {
    const read = () => {
      const selection = window.getSelection();
      const root = container.current;
      const quotable = selection?.rangeCount ? quotableRange(selection.getRangeAt(0)) : null;
      const range = quotable?.inside;
      const message = quotable?.root.closest<HTMLElement>('[data-slot="message"]');
      const text = (range && quotable.root.getAttribute("data-quotable") === "typed" && typedText(range)) || (selection?.toString() ?? "");
      if (!root || !range || !message || !root.contains(quotable.root) || !text.trim()) {
        setPassage(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {
        setPassage(null);
        return;
      }
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? rect;
      const below = last.bottom + 6;
      setPassage({
        text,
        source: quoteSource(message.dataset.from, message.dataset.provider ?? latest.current.provider),
        left: Math.max(8, Math.min(window.innerWidth - 140, last.right - 48)),
        top: below + 32 < window.innerHeight ? below : Math.max(8, rect.top - 38),
      });
    };
    const clear = () => setPassage(null);
    const keydown = (event: KeyboardEvent) => {
      if (!latest.current.passage) return;
      if (event.key === "Escape") clear();
      else if (shortcutCommand(event) === "chat.quote") {
        event.preventDefault();
        quote();
      }
    };
    document.addEventListener("selectionchange", read);
    document.addEventListener("scroll", clear, true);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("scroll", clear, true);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", clear);
    };
  }, [container, quote]);
  return (
    passage &&
    createPortal(
      <button
        type="button"
        aria-label="Quote selected text"
        className="fixed z-50 flex h-8 items-center gap-2 rounded-control bg-surface px-3 text-13 font-medium text-ink shadow-raised transition-colors hover:bg-[linear-gradient(var(--hover),var(--hover))] focus-visible:outline-accent"
        style={{ left: passage.left, top: passage.top }}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          quote();
        }}
      >
        Quote
        {shortcut && <span className="text-12 font-normal text-ink-3">{shortcut}</span>}
      </button>,
      document.body,
    )
  );
}
