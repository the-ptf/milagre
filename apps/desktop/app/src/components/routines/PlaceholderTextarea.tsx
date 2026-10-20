import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { CodeIcon } from "@hugeicons/core-free-icons";
import { insertPlaceholder, placeholderQuery } from "@milagre/shared/routine-prompt";
import { ScrollArea } from "../primitives/ScrollArea";

type Entry = { name: string; example: string };
type Open = { start: number; caret: number; matches: Entry[] };
const LIST_ROOM = 200;

/** "body." for a dynamic name like "body.<path>": inserting it leaves the caret where the path goes. */
const dynamicPrefix = (name: string) => (name.includes("<") ? name.slice(0, name.indexOf("<")) : null);

/**
 * The Routine prompt: a textarea where typing `{{` lists the trigger's placeholders, with an example of each, in a list
 * anchored under the textarea. Up and Down move, Enter or Tab inserts, Escape dismisses (and goes no further, so the
 * form stays open).
 */
export function PlaceholderTextarea({
  value,
  onChange,
  placeholders,
  label,
  invalid = false,
  rows = 4,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholders: Entry[];
  label: string;
  invalid?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [active, setActive] = useState(0);
  // The `{{` the user dismissed with Escape; it stays closed until they start another.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  // The list goes into the open modal dialog (above the page, outside the form's scroll fade, whose mask would clip it).
  const [host, setHost] = useState<Element | null>(null);

  const look = (text: string, caret: number) => {
    const found = placeholderQuery(
      text,
      caret,
      placeholders.map((entry) => entry.name),
    );
    if (!found || found.start === dismissed || found.matches.length === 0) {
      setOpen(null);
      if (!found) setDismissed(null);
      return;
    }
    const matches = found.matches.map((name) => placeholders.find((entry) => entry.name === name)!);
    setOpen((previous) => {
      if (previous?.start !== found.start || previous.matches.length !== matches.length) setActive(0);
      return { start: found.start, caret, matches };
    });
    const rect = textarea.current?.getBoundingClientRect();
    setHost(textarea.current?.closest("dialog[open]") ?? null);
    if (rect) {
      // Under the textarea, or above it when the window has no room below.
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const width = Math.min(320, rect.width);
      setAnchor(
        below >= LIST_ROOM || below >= above
          ? { left: rect.left, width, top: rect.bottom + 4, maxHeight: below }
          : { left: rect.left, width, bottom: window.innerHeight - rect.top + 4, maxHeight: above },
      );
    }
  };

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !textarea.current) return;
    textarea.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const choose = (entry: Entry) => {
    if (!open) return;
    const prefix = dynamicPrefix(entry.name);
    const next = prefix
      ? { text: `${value.slice(0, open.start)}{{${prefix}${value.slice(open.caret)}`, caret: open.start + 2 + prefix.length }
      : insertPlaceholder(value, open.start, open.caret, entry.name);
    pendingCaret.current = next.caret;
    setOpen(null);
    onChange(next.text);
    textarea.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + open.matches.length) % open.matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(open.matches[active] ?? open.matches[0]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(open.start);
      setOpen(null);
    }
  };

  return (
    <>
      <textarea
        ref={textarea}
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open !== null}
        aria-controls={open ? "routine-placeholders" : undefined}
        data-routine-prompt
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          look(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => look(event.currentTarget.value, event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(null)}
        className={`w-full resize-y rounded-lg border bg-surface px-3 py-2 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:ring-1 focus:ring-ink ${invalid ? "border-red" : "border-line-strong"}`}
      />
      {open &&
        anchor &&
        createPortal(
          <ScrollArea
            id="routine-placeholders"
            role="listbox"
            aria-label="Placeholders"
            data-routine-placeholders
            className="fixed z-50 rounded-[12px] border border-line-strong bg-surface p-1.5 shadow-overlay"
            style={{ left: anchor.left, top: anchor.top, bottom: anchor.bottom, width: anchor.width, maxHeight: Math.min(anchor.maxHeight, 280) }}
            // Keep focus in the textarea while picking with the mouse.
            onMouseDown={(event) => event.preventDefault()}
          >
            {open.matches.map((entry, index) => (
              <button
                key={entry.name}
                type="button"
                role="option"
                aria-selected={index === active}
                data-placeholder={entry.name}
                onMouseEnter={() => setActive(index)}
                ref={index === active ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
                onClick={() => choose(entry)}
                className={`flex h-9 w-full items-center gap-2 rounded-[8px] px-2 text-left ${index === active ? "bg-hover-2" : ""}`}
              >
                <HugeiconsIcon icon={CodeIcon} size={14} strokeWidth={1.8} color="currentColor" className={index === active ? "text-ink" : "text-ink-2"} />
                <span className={`shrink-0 text-[13px] text-ink ${index === active ? "font-medium" : ""}`}>{entry.name}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-2">{entry.example}</span>
              </button>
            ))}
          </ScrollArea>,
          host ?? document.body,
        )}
    </>
  );
}
