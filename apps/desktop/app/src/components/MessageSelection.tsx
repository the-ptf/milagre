import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Keeps browser text selection intact and offers the same Ask action as the phone's selection menu. */
export function MessageSelection({ container, onAsk }: { container: RefObject<HTMLElement | null>; onAsk: (text: string) => void }) {
  const [passage, setPassage] = useState<{ text: string; left: number; top: number } | null>(null);
  useEffect(() => {
    const read = () => {
      const selection = window.getSelection();
      const root = container.current;
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const element = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement);
      const start = element(range?.startContainer)?.closest('[data-slot="message"]');
      const end = element(range?.endContainer)?.closest('[data-slot="message"]');
      const text = selection?.toString() ?? "";
      if (!root || !range || !start || !end || !root.contains(start) || !root.contains(end) || !text.trim()) {
        setPassage(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight) {
        setPassage(null);
        return;
      }
      setPassage({ text, left: Math.max(8, Math.min(window.innerWidth - 64, rect.left)), top: Math.max(8, rect.top - 36) });
    };
    const clear = () => setPassage(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    document.addEventListener("selectionchange", read);
    document.addEventListener("scroll", clear, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("scroll", clear, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", clear);
    };
  }, [container]);
  return (
    passage &&
    createPortal(
      <button
        type="button"
        aria-label="Ask about selected text"
        className="fixed z-50 h-8 rounded-control bg-surface px-3 text-13 font-medium text-ink shadow-raised hover:bg-hover focus-visible:outline-accent"
        style={{ left: passage.left, top: passage.top }}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          onAsk(passage.text);
          window.getSelection()?.removeAllRanges();
          setPassage(null);
        }}
      >
        Ask
      </button>,
      document.body,
    )
  );
}
