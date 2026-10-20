import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openModal } from "../../lib/modal";
import { shortcutModifier, useShortcutHints } from "../../lib/shortcut-hints";
import { ShortcutKeys } from "./ShortcutKeys";

const TOOLTIP_SHOW_DELAY = 400;

/** Shared tooltip presentation for ordinary triggers and text hit-tested under a native input. */
function TooltipBubble({
  label,
  rect,
  align = "start",
  side = "top",
  wrap = false,
  hint,
}: {
  label: string;
  rect: DOMRect;
  align?: "start" | "end";
  side?: "top" | "bottom";
  wrap?: boolean;
  hint?: string;
}) {
  return createPortal(
    <span
      role="tooltip"
      className={`pointer-events-none fixed z-[60] flex items-center gap-2 ${wrap ? "max-w-[280px] whitespace-normal leading-snug" : "whitespace-nowrap"} rounded-[8px] bg-ink px-2 py-1 text-[12px] font-medium text-surface shadow-overlay`}
      style={{
        ...(side === "top" ? { top: rect.top - 6 } : { top: rect.bottom + 6 }),
        ...(align === "start" ? { left: rect.left } : { right: window.innerWidth - rect.right }),
        transform: side === "top" ? "translateY(-100%)" : undefined,
        animation: "fade-in 120ms ease-out both",
      }}
    >
      {label}
      {hint && <ShortcutKeys shortcut={hint} plain className="opacity-70" />}
    </span>,
    document.body,
  );
}

export default function Tooltip({
  label,
  shortcut,
  keyHint,
  align = "start",
  side = "top",
  wrap = false,
  compactHint = false,
  className = "",
  children,
}: {
  label: string;
  shortcut?: string;
  /** A key pressed on its own, without ⌘ (the canvas's C): shown in the tooltip, not with the hints holding ⌘ shows. */
  keyHint?: string;
  align?: "start" | "end";
  /** Which side of the trigger the tooltip opens on; "bottom" for triggers at the window's top edge. */
  side?: "top" | "bottom";
  /** Lets a long label break onto more lines instead of running past the window. */
  wrap?: boolean;
  /** For a row of icon buttons too close for full hints: smaller keys, just under its button instead of over it. */
  compactHint?: boolean;
  /** Extra classes for the trigger wrapper, e.g. to position it. */
  className?: string;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const showHints = useShortcutHints();
  const [hintRect, setHintRect] = useState<DOMRect | null>(null);
  const hintRef = useRef<HTMLElement>(null);
  const hint = (shortcut ?? keyHint)?.replace("⌘", shortcutModifier);
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const modal = openModal();
    const bounds = trigger?.getBoundingClientRect();
    setHintRect(showHints && shortcut && bounds?.width && bounds.height && (!modal || modal.contains(trigger)) ? bounds : null);
  }, [showHints, shortcut]);
  useLayoutEffect(() => {
    const badge = hintRef.current;
    if (!badge || !hintRect) return;
    const half = badge.getBoundingClientRect().width / 2;
    const anchor = hintRect.width > 80 ? hintRect.right - 22 : hintRect.left + hintRect.width / 2;
    badge.style.left = `${Math.max(8 + half, Math.min(window.innerWidth - 8 - half, anchor))}px`;
  }, [hintRect, hint, rect]);

  const clear = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const show = (delay: number) => {
    clear();
    timerRef.current = window.setTimeout(() => setRect(triggerRef.current?.getBoundingClientRect() ?? null), delay);
  };
  const hide = () => {
    clear();
    setRect(null);
  };

  useEffect(() => clear, []);

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className}`}
      onPointerEnter={() => show(TOOLTIP_SHOW_DELAY)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) show(0);
      }}
      onBlur={hide}
    >
      {children}
      {rect && <TooltipBubble label={label} rect={rect} align={align} side={side} wrap={wrap} hint={hint} />}
      {hintRect &&
        !rect &&
        createPortal(
          <ShortcutKeys
            ref={hintRef}
            shortcut={hint!}
            compact={compactHint}
            aria-hidden="true"
            className="pointer-events-none fixed z-[70]"
            style={{
              top: compactHint ? hintRect.bottom + 12 : hintRect.top + hintRect.height / 2,
              left: hintRect.width > 80 ? hintRect.right - 22 : hintRect.left + hintRect.width / 2,
              transform: "translate(-50%, -50%)",
            }}
          />,
          document.body,
        )}
    </span>
  );
}
