import { useEffect, useRef, useState } from "react";
import type { ModelProvider } from "../../model";
import { useSettings } from "../../lib/settings";
import { PROVIDER_NAMES, formatPercent, shownPercent, usageLabel, visibleProviders } from "./format";
import { ProviderLogo } from "../ProviderLogo";
import { UsageBar } from "./UsageBar";
import { USAGE_CARD_WIDTH, UsageCard } from "./UsageCard";
import type { UsageState } from "./useUsage";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 150;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 12;
const STALE_AFTER_MS = 60_000;

type OpenCard = { provider: ModelProvider; left: number; bottom: number };

// The fullest window, so the collapsed rail shows whichever limit is closest.
function peakPercent(windows: { usedPercent: number }[]) {
  return windows.reduce((peak, item) => Math.max(peak, item.usedPercent), 0);
}

/** Plan usage rows for the sidebar footer; the card opens beside the sidebar, expanded or collapsed. */
export function SidebarUsage({ usage, scope }: { usage: UsageState; scope?: string }) {
  const [openCard, setOpenCard] = useState<OpenCard | null>(null);
  const { usageDisplay } = useSettings();
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const segments = useRef(new Map<ModelProvider, HTMLButtonElement>());
  const restoringFocus = useRef(false);
  // The card's account picker opens its panel outside the card; leaving the card for it must not close the card.
  const pickerOpen = useRef(false);
  const providers = usage.snapshot ? visibleProviders(usage.snapshot) : [];
  const openUsage = openCard ? providers.find((item) => item.provider === openCard.provider) : undefined;

  function clearTimers() {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }

  function show(provider: ModelProvider) {
    clearTimers();
    const segment = segments.current.get(provider);
    if (!segment) return;
    const rect = segment.getBoundingClientRect();
    const sidebarRight = segment.closest("aside")?.getBoundingClientRect().right ?? rect.right;
    const left = Math.min(sidebarRight + CARD_GAP, window.innerWidth - USAGE_CARD_WIDTH - VIEWPORT_MARGIN);
    setOpenCard({ provider, left, bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.bottom) });
    usage.refreshIfStale(STALE_AFTER_MS);
  }

  function scheduleShow(provider: ModelProvider) {
    clearTimers();
    openTimer.current = window.setTimeout(() => show(provider), OPEN_DELAY_MS);
  }

  function scheduleHide() {
    if (pickerOpen.current) return;
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpenCard(null), CLOSE_DELAY_MS);
  }

  function keepOpen() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!openCard) pickerOpen.current = false;
  }, [openCard]);

  useEffect(() => {
    if (!openCard) return;
    const close = () => setOpenCard(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [openCard]);

  useEffect(() => {
    if (!openCard || !openUsage) return;
    const segment = segments.current.get(openCard.provider);
    // Capture on window runs before App's window-level Escape handler, which cancels
    // the running agent, so Escape closes the card wherever focus is and goes no further.
    const closeOnEscape = (event: KeyboardEvent) => {
      // The open picker takes this Escape and closes itself; the card stays.
      if (event.key !== "Escape" || pickerOpen.current) return;
      event.preventDefault();
      event.stopPropagation();
      const focusInCard = Boolean((document.activeElement as Element | null)?.closest("[data-usage-card]"));
      clearTimers();
      setOpenCard(null);
      if (focusInCard && segment) {
        restoringFocus.current = true;
        segment.focus();
        restoringFocus.current = false;
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [openCard, openUsage]);

  if (providers.length === 0) return null;

  return (
    <div className="sidebar-usage flex flex-col gap-0.5">
      {providers.map((item) => {
        const expanded = openCard?.provider === item.provider && Boolean(openUsage);
        return (
          <button
            key={item.provider}
            ref={(node) => {
              if (node) segments.current.set(item.provider, node);
              else segments.current.delete(item.provider);
            }}
            type="button"
            aria-label={usageLabel(item, usageDisplay)}
            aria-expanded={expanded}
            aria-controls={expanded ? `usage-card-${item.provider}` : undefined}
            onPointerEnter={() => scheduleShow(item.provider)}
            onPointerLeave={scheduleHide}
            onFocus={(event) => {
              if (!restoringFocus.current && event.currentTarget.matches(":focus-visible")) show(item.provider);
            }}
            onBlur={(event) => {
              if (!(event.relatedTarget as Element | null)?.closest("[data-usage-card]")) scheduleHide();
            }}
            onClick={() => show(item.provider)}
            className={`sidebar-usage-row relative flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[8px] px-2 text-[12px] tabular-nums text-ink-2 transition-[background-color,color,opacity] duration-150 hover:bg-hover-2 hover:text-ink ${expanded ? "bg-hover-2 text-ink" : ""} ${item.status === "error" ? "opacity-60" : ""}`}
          >
            <span className="flex shrink-0 items-center justify-center">
              <ProviderLogo provider={item.provider} size={13} />
            </span>
            <span className="sidebar-copy min-w-0 truncate text-ink-2">{PROVIDER_NAMES[item.provider]}</span>
            {item.windows.length === 0 ? (
              <span className="sidebar-copy ml-auto text-ink-3">—</span>
            ) : (
              <span className="sidebar-copy ml-auto flex w-[104px] shrink-0 items-center gap-2">
                {/* Share the meter area equally; a single window spans the full width. */}
                {item.windows.slice(0, 2).map((entry) => (
                  <span key={entry.id} className="flex min-w-0 flex-1 flex-col items-end gap-[3px]">
                    <span className="flex items-baseline gap-[3px] whitespace-nowrap leading-none">
                      <span className="text-ink">{formatPercent(shownPercent(entry.usedPercent, usageDisplay))}</span>
                      <span className="text-ink-3">{entry.shortLabel}</span>
                    </span>
                    <UsageBar usedPercent={entry.usedPercent} display={usageDisplay} className="h-[2px] w-full" />
                  </span>
                ))}
              </span>
            )}
            {item.windows.length > 0 && (
              <span aria-hidden className="sidebar-usage-rail absolute bottom-[3px] left-1/2 -translate-x-1/2">
                <UsageBar usedPercent={peakPercent(item.windows)} display={usageDisplay} className="h-[2px] w-4" />
              </span>
            )}
          </button>
        );
      })}

      {openCard && openUsage && (
        <UsageCard
          id={`usage-card-${openUsage.provider}`}
          usage={openUsage}
          scope={scope}
          onPickerOpenChange={(open) => {
            pickerOpen.current = open;
            if (open) return;
            // A choice or Escape hands focus back to the picker, in the card, after this runs; a click elsewhere
            // leaves it nowhere, and the pointer may have left the card while the panel was open.
            window.setTimeout(() => {
              const card = document.getElementById(`usage-card-${openUsage.provider}`);
              if (card && !card.matches(":hover") && !card.contains(document.activeElement)) scheduleHide();
            }, 0);
          }}
          loading={usage.loading}
          position={{ left: openCard.left, bottom: openCard.bottom }}
          onRefresh={() => void usage.refresh()}
          onPointerEnter={keepOpen}
          onPointerLeave={scheduleHide}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            const segment = segments.current.get(openUsage.provider);
            if (next && (event.currentTarget.contains(next) || segment?.contains(next))) return;
            scheduleHide();
          }}
        />
      )}
    </div>
  );
}
