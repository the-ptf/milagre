import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { clampMatch, findLabel, locateOffset, matchOffsets, stepMatch } from "../lib/find-in-chat";
import { isMac } from "../lib/shortcut-hints";
import Tooltip from "./primitives/Tooltip";

const MATCH = "find-match";
const ACTIVE = "find-active";

/** The nearest ancestor that isn't inline, so "a **bold** word" reads as one string. */
function blockOf(element: Element, cache: Map<Element, Element>): Element {
  const cached = cache.get(element);
  if (cached) return cached;
  let block = element;
  while (block.parentElement && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
  cache.set(element, block);
  return block;
}

/** Text ranges for every match under `root`, including ones that cross inline markup. Hidden and inert text (collapsed tool rows) is skipped. */
function collectRanges(root: Element, query: string): Range[] {
  const ranges: Range[] = [];
  const visible = new Map<Element, boolean>();
  const blocks = new Map<Element, Element>();
  let group: Text[] = [];
  let groupBlock: Element | null = null;
  const flush = () => {
    const nodes = group;
    group = [];
    if (!nodes.length) return;
    const lengths = nodes.map((node) => node.data.length);
    for (const start of matchOffsets(nodes.map((node) => node.data).join(""), query)) {
      const from = locateOffset(lengths, start, "start");
      const to = locateOffset(lengths, start + query.length, "end");
      const startNode = nodes[from.index];
      const endNode = nodes[to.index];
      if (!startNode || !endNode) continue;
      const range = document.createRange();
      range.setStart(startNode, from.offset);
      range.setEnd(endNode, to.offset);
      ranges.push(range);
    }
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (!visible.has(parent)) visible.set(parent, !parent.closest("script, style, [inert]") && (parent.checkVisibility?.() ?? true));
    if (!visible.get(parent)) continue;
    const block = blockOf(parent, blocks);
    if (block !== groupBlock) {
      flush();
      groupBlock = block;
    }
    group.push(node);
  }
  flush();
  return ranges;
}

function paint(ranges: Range[], active: number) {
  // The highlight registry paints without touching the DOM, so the find bar's own input is never matched.
  CSS.highlights.set(MATCH, new Highlight(...ranges));
  if (ranges[active]) CSS.highlights.set(ACTIVE, new Highlight(ranges[active]));
  else CSS.highlights.delete(ACTIVE);
}

function clear() {
  CSS.highlights.delete(MATCH);
  CSS.highlights.delete(ACTIVE);
}

const iconButton =
  "flex size-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40";

/** Find-in-page for the open chat, scoped to the message list under `rootRef` (highlights via the CSS Custom Highlight API). */
export function FindBar({
  rootRef,
  focusSignal,
  seed,
  onClose,
}: {
  rootRef: RefObject<HTMLElement | null>;
  focusSignal: number;
  /** Replaces the query each time `focusSignal` changes. */
  seed?: string;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(seed ?? "");
  const [active, setActive] = useState(0);
  const [total, setTotal] = useState(0);
  const [version, setVersion] = useState(0);
  const ranges = useRef<Range[]>([]);
  const activeRef = useRef(0);
  const reveal = useRef(true);

  // Re-run after the chat DOM changes (streaming replies, expanded rows); the active match is kept in range.
  function search(jump: boolean) {
    const column = rootRef.current?.querySelector(".chat-column");
    ranges.current = column && query ? collectRanges(column, query) : [];
    const next = jump ? 0 : clampMatch(activeRef.current, ranges.current.length);
    activeRef.current = next;
    reveal.current = jump;
    setTotal(ranges.current.length);
    setVersion((current) => current + 1);
    setActive(next);
  }

  useEffect(() => {
    search(true);
    const column = rootRef.current?.querySelector(".chat-column");
    if (!column || !query) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => search(false));
    });
    observer.observe(column, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["inert"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [query]);

  useEffect(() => {
    paint(ranges.current, active);
    if (!reveal.current) return;
    ranges.current[active]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, [active, version]);

  // Closing returns focus to where it was, usually the composer.
  const returnTo = useRef(document.activeElement);
  useEffect(
    () => () => {
      clear();
      const target = returnTo.current;
      const prompt = rootRef.current?.querySelector<HTMLElement>("[data-prompt-editor]");
      (target instanceof HTMLElement && target.isConnected && target !== document.body ? target : prompt)?.focus();
    },
    [],
  );

  // Reopening while open selects the text, so a new search replaces the old one.
  useLayoutEffect(() => {
    if (seed !== undefined) setQuery(seed);
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  function step(direction: 1 | -1) {
    if (!total) return;
    activeRef.current = stepMatch(activeRef.current, total, direction);
    reveal.current = true;
    setActive(activeRef.current);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || !(isMac ? event.metaKey : event.ctrlKey) || event.key.toLowerCase() !== "g") return;
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      role="search"
      data-find-bar
      className="absolute top-11 right-4 z-20 flex items-center gap-1 rounded-[10px] border border-line bg-surface py-1 pr-1 pl-2.5 shadow-raised [-webkit-app-region:no-drag]"
      style={{ animation: "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <input
        ref={input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
        aria-label="Find in chat"
        placeholder="Find in chat"
        spellCheck={false}
        autoComplete="off"
        className="w-44 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
      />
      <span data-find-count aria-live="polite" className="min-w-[4.5rem] text-right text-[12px] whitespace-nowrap text-ink-3 tabular-nums">
        {findLabel(query, active, total)}
      </span>
      <Tooltip label="Previous match" side="bottom" align="end">
        <button type="button" aria-label="Previous match" disabled={!total} onClick={() => step(-1)} className={iconButton}>
          <HugeiconsIcon icon={ArrowUp01Icon} size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip label="Next match" shortcut="⌘G" side="bottom" align="end">
        <button type="button" aria-label="Next match" disabled={!total} onClick={() => step(1)} className={iconButton}>
          <HugeiconsIcon icon={ArrowDown01Icon} size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip label="Close" side="bottom" align="end">
        <button type="button" aria-label="Close find" onClick={onClose} className={iconButton}>
          <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  );
}
