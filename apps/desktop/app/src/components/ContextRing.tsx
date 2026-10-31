import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextUsage } from "../model";
import { useDismiss } from "../lib/use-dismiss";
import { contextSummary } from "./usage/format";
import { ContextBar } from "./ContextBar";
import { CONTEXT_DEFAULTS, type ContextSettings } from "@milagre/shared/context-settings";
import Tooltip from "./primitives/Tooltip";

const CARD_WIDTH = 264;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 12;
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 150;

type Position = { left: number; bottom: number };

/**
 * The context percentage and its usage popover, beside Send.
 * Hover, focus or click opens a card above it with the numbers, styled like the plan usage card. On a Claude chat the
 * card offers Compact now (`onCompact`), which sends `/compact`; `compactBlocked` says why it can't right now.
 */
export function ContextRing({
  onCompact,
  compactBlocked = null,
  settings = CONTEXT_DEFAULTS,
  showSize = true,
  compactLabel = "Compact now",
  ...usage
}: ContextUsage & { onCompact?: () => void; compactBlocked?: string | null; settings?: ContextSettings; showSize?: boolean; compactLabel?: string }) {
  const { percent, tokens } = contextSummary(usage);
  const attention = Boolean(onCompact) && percent >= settings.buttonThreshold;
  const label = `Context: ${percent}% used (${tokens})`;
  const [position, setPosition] = useState<Position | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);

  function clearTimer() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  function place() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.right - CARD_WIDTH, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)),
      bottom: window.innerHeight - rect.top + CARD_GAP,
    });
  }

  function show() {
    clearTimer();
    place();
  }

  function schedule(next: () => void, delay: number) {
    clearTimer();
    timer.current = window.setTimeout(next, delay);
  }

  function hide() {
    clearTimer();
    setPosition(null);
  }

  useEffect(() => clearTimer, []);

  useDismiss(position !== null, hide, (target) => Boolean(target.closest("[data-context-card]")) || Boolean(trigger.current?.contains(target)), place);

  useEffect(() => {
    if (!position) return;
    // Capture runs before App's window-level Escape handler, which cancels the running agent.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [position]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-description={attention ? "Compaction recommended. Open context details to compact." : undefined}
        aria-expanded={position !== null}
        aria-controls={position ? "context-card" : undefined}
        onPointerEnter={() => schedule(show, OPEN_DELAY_MS)}
        onPointerLeave={() => schedule(hide, CLOSE_DELAY_MS)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show();
        }}
        onBlur={(event) => {
          // Focus moving into the card (its Compact now button) keeps it open.
          if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-context-card]"))) hide();
        }}
        onClick={() => (position ? hide() : show())}
        className={`relative flex h-7 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-12 tabular-nums ${attention ? "text-orange-ink" : "text-ink-2"} transition-[background-color] duration-150 hover:bg-hover-2 ${position ? "bg-hover-2" : ""}`}
      >
        {showSize ? (
          <>
            <span aria-hidden className="hidden h-1 w-4 overflow-hidden rounded-full bg-line-strong @min-[700px]:block">
              <span className="block h-full bg-current" style={{ width: `${percent}%` }} />
            </span>
            <span aria-hidden>{percent}%</span>
          </>
        ) : (
          <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
        )}
      </button>
      {position &&
        createPortal(
          <div
            id="context-card"
            role="dialog"
            aria-label="Context window"
            data-context-card
            onPointerEnter={clearTimer}
            onPointerLeave={() => schedule(hide, CLOSE_DELAY_MS)}
            className="fixed z-50 rounded-[14px] bg-surface text-ink shadow-overlay"
            style={{
              width: CARD_WIDTH,
              left: position.left,
              bottom: position.bottom,
              animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: "bottom right",
            }}
          >
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-12 tabular-nums text-ink-2">{tokens}</p>
              <ContextBar percent={percent} settings={settings} />
              {onCompact && (
                <Tooltip label={compactBlocked || "Summarize this Chat to free up context."} className="w-full" wrap>
                  <button
                    type="button"
                    data-compact-now
                    disabled={Boolean(compactBlocked)}
                    onClick={() => {
                      hide();
                      onCompact();
                    }}
                    className="inline-flex h-8 w-full items-center justify-center rounded-control bg-orange/15 px-2.5 text-12 font-medium text-orange-ink disabled:opacity-40"
                  >
                    {compactLabel}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
