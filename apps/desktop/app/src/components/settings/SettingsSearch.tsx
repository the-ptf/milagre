import { FieldGroup } from "../primitives/Field";
import { IconButton } from "../primitives/Button";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { searchSettings, searchTrail, type SettingsSearchEntry } from "@milagre/shared/settings-search";
import { shortcutCommand } from "../../lib/keybindings";
import { findLabelElement, rowOf, useSettingsFindTarget } from "../../lib/settings-find";
import { ScrollArea } from "../primitives/ScrollArea";

/** Something the Settings search can open: a section, a row in one, a computer or a Project. */
export type SettingsSearchItem = SettingsSearchEntry & { key: string; icon?: ReactNode; open: () => void };

/**
 * The search field at the top of the Settings nav. ⌘F (the Find in Chat keys) focuses it while Settings is open; ↑ and ↓
 * move through the results, Return opens one, Escape clears the query before it leaves Settings.
 */
export function SettingsSearchField({
  query,
  onQuery,
  onMove,
  onOpen,
}: {
  query: string;
  onQuery: (query: string) => void;
  onMove: (step: 1 | -1) => void;
  onOpen: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Capture, so Settings takes the keys before a Chat's Find, which isn't on screen.
    const focus = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || shortcutCommand(event) !== "chat.find") return;
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", focus, true);
    return () => window.removeEventListener("keydown", focus, true);
  }, []);
  return (
    // Ends with the nav rows, which keep 10px for the list's scrollbar; icon and text sit on the rows' icon and label lines
    // (an 8px inset counting the clear border, a 16px icon in an 18px slot, then the 8px gap). Bare, on the nav's own
    // fill, so it doesn't read as the selected row.
    <div className="mr-4.5 mb-1 ml-2 shrink-0">
      <FieldGroup
        size={32}
        fill="page"
        className="pl-[7px]"
        leading={
          <span className="flex w-[18px] shrink-0">
            <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.8} className="text-ink-3" />
          </span>
        }
        trailing={
          query ? (
            <IconButton
              label="Clear search"
              icon={Cancel01Icon}
              size={24}
              onClick={() => {
                onQuery("");
                input.current?.focus();
              }}
            />
          ) : undefined
        }
        ref={input}
        data-settings-search
        type="text"
        value={query}
        spellCheck={false}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onMove(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "Escape" && query) {
            event.preventDefault();
            onQuery("");
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
      />
    </div>
  );
}

/** The query's letters in bold ink, the rest as they were. */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="bg-transparent font-semibold text-ink">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** The ranked results for `query`, with the one ↑/↓ points at; `active` is clamped into the list. */
export function useSettingsSearch(items: readonly SettingsSearchItem[], query: string, pageTitle: (page: string) => string) {
  // The pointed-at result, for the query it was picked in: a new query starts back at the top.
  const [pointer, setPointer] = useState({ query, index: 0 });
  const active = pointer.query === query ? pointer.index : 0;
  const setActive = (index: number) => setPointer({ query, index });
  const hits = useMemo(() => searchSettings(items, query, pageTitle), [items, query, pageTitle]);
  const shown = hits.length ? Math.min(active, hits.length - 1) : -1;
  return {
    hits,
    active: shown,
    setActive,
    move: (step: 1 | -1) => setActive(hits.length ? (shown + step + hits.length) % hits.length : 0),
  };
}

export function SettingsSearchResults({
  hits,
  active,
  pageTitle,
  onHover,
}: {
  hits: ReturnType<typeof useSettingsSearch>["hits"];
  active: number;
  pageTitle: (page: string) => string;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!hits.length) return <p className="mx-4 mt-3 text-13 text-ink-3">No settings match.</p>;
  return (
    <ScrollArea as="ul" ref={list} aria-label="Settings search results" className="min-h-0 flex-1 pb-2 [scrollbar-gutter:stable]">
      {hits.map(({ entry, ranges }, index) => {
        const item = entry as SettingsSearchItem;
        const trail = searchTrail(entry, pageTitle(entry.page));
        return (
          <li key={item.key}>
            <button
              type="button"
              data-settings-result
              data-index={index}
              aria-current={index === active || undefined}
              onPointerEnter={() => onHover(index)}
              onClick={() => {
                onHover(index);
                item.open();
              }}
              className={`mx-2 flex w-[calc(100%-16px)] items-center gap-1.5 rounded-control px-2 py-1.5 text-left transition-colors ${index === active ? "bg-hover-2" : ""}`}
            >
              {item.icon && <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">{item.icon}</span>}
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-13 font-medium text-ink-2">
                  <Marked text={entry.title} ranges={ranges} />
                </span>
                {trail !== entry.title && <span className="truncate text-12 text-ink-3">{trail}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ScrollArea>
  );
}

/**
 * Lights up the row a search result named once `section` renders it: scrolls it to the middle and tints it, fading out.
 * Rows that read from the Mac appear a moment later, so it watches the panel for a few seconds before giving up.
 */
export function useFoundRow(root: RefObject<HTMLElement | null>, section: string) {
  const target = useSettingsFindTarget();
  useEffect(() => {
    const container = root.current;
    if (!target || target.section !== section || !container) return;
    let fade: ReturnType<typeof setTimeout> | undefined;
    let lit: HTMLElement | null = null;
    const light = () => {
      const label = findLabelElement(container, target.title);
      if (!label) return false;
      lit = rowOf(label);
      lit.removeAttribute("data-settings-found");
      // Reflow, so the same row found twice plays the tint again.
      void lit.offsetWidth;
      lit.setAttribute("data-settings-found", "");
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      lit.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      fade = setTimeout(() => lit?.removeAttribute("data-settings-found"), 2600);
      return true;
    };
    if (light()) return () => clearTimeout(fade);
    const observer = new MutationObserver(() => {
      if (light()) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const giveUp = setTimeout(() => observer.disconnect(), 5000);
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
      clearTimeout(fade);
      lit?.removeAttribute("data-settings-found");
    };
  }, [target, section, root]);
}
