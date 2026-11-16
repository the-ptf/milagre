import { useEffect, useId, useRef, useState } from "react";
import { Alert02Icon, DashboardSpeed02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { Popover } from "../primitives/Popover";
import { ProviderLogo } from "../ProviderLogo";
import { PROVIDER_NAMES, USAGE_BUTTON_LABEL, formatUpdatedAgo, overviewUpdatedAt, visibleProviders } from "./format";
import { AccountPicker, USAGE_CARD_WIDTH, UsageWindows } from "./UsageCard";
import { useRefreshSpin } from "../changes/useRefreshSpin";
import type { UsageState } from "./useUsage";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 150;
const STALE_AFTER_MS = 60_000;

/**
 * Settings › General › Plan usage › Show in sidebar › Button: one footer button beside Filters. Hovering it (or focusing
 * it from the keyboard, or clicking it) opens a popover with every provider's windows, the meters' cards in one panel.
 */
export function UsageButton({ usage, scope, chatsHome }: { usage: UsageState; scope?: string; chatsHome?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // The pointer is over the button or the popover: a click there moves focus off the button, which mustn't close it.
  const pointerInside = useRef(false);
  const pickerOpen = useRef(false);
  const pickerClosing = useRef(false);
  const spin = useRefreshSpin(() => usage.refresh(), usage.loading);
  const providers = usage.snapshot ? visibleProviders(usage.snapshot) : [];
  const updatedAt = overviewUpdatedAt(usage.snapshot);

  function clearTimers() {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }

  function show() {
    clearTimers();
    setNow(Date.now());
    setOpen(true);
    usage.refreshIfStale(STALE_AFTER_MS);
  }

  function close() {
    if (pickerOpen.current || pickerClosing.current) return;
    clearTimers();
    setOpen(false);
  }

  function scheduleShow() {
    pointerInside.current = true;
    clearTimers();
    openTimer.current = window.setTimeout(show, OPEN_DELAY_MS);
  }

  function leave() {
    pointerInside.current = false;
    scheduleHide();
  }

  function scheduleHide() {
    if (pickerOpen.current) return;
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  function keepOpen() {
    pointerInside.current = true;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }

  function onPickerOpenChange(next: boolean) {
    pickerOpen.current = next;
    if (next) return;
    pickerClosing.current = true;
    // A choice or Escape hands focus back to the picker after this runs; a press elsewhere leaves the pointer
    window.setTimeout(() => {
      pickerClosing.current = false;
      const panel = document.querySelector("[data-usage-popover]");
      if (panel && !panel.matches(":hover") && !panel.contains(document.activeElement)) scheduleHide();
    }, 0);
  }

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!open) pickerOpen.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pickerOpen.current) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  return (
    <>
      <IconButton
        ref={button}
        size={32}
        label={USAGE_BUTTON_LABEL}
        tooltip={false}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-usage-button=""
        onPointerEnter={scheduleShow}
        onPointerLeave={leave}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) show();
        }}
        onBlur={() => {
          if (!pointerInside.current) scheduleHide();
        }}
        // Opens, never toggles: the pointer that clicks it has usually opened it already.
        onClick={show}
      >
        <Icon icon={DashboardSpeed02Icon} size={16} />
      </IconButton>
      {open && (
        <Popover
          anchor={button}
          align="start"
          width={USAGE_CARD_WIDTH}
          role="dialog"
          label={USAGE_BUTTON_LABEL}
          onClose={close}
          onPointerEnter={keepOpen}
          onPointerLeave={leave}
          data-usage-popover=""
        >
          <div id={id} className="flex flex-col">
            {providers.map((item, index) => {
              const account = item.account?.email || item.account?.label;
              return (
                <section
                  key={`${item.provider}:${item.account?.id ?? ""}`}
                  aria-label={`${PROVIDER_NAMES[item.provider]} usage`}
                  data-usage-provider={item.provider}
                  className={`flex flex-col gap-2 px-2 py-2 ${index > 0 ? "border-t border-line" : ""}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex shrink-0">
                      <ProviderLogo provider={item.provider} size={16} />
                    </span>
                    <span className="shrink-0 text-13 font-medium text-ink">{PROVIDER_NAMES[item.provider]}</span>
                    <span className="ml-auto flex min-w-0">
                      {scope ? (
                        <AccountPicker
                          key={scope}
                          scope={scope}
                          chatsHome={chatsHome}
                          provider={item.provider}
                          account={account}
                          small
                          onOpenChange={onPickerOpenChange}
                        />
                      ) : (
                        account && <span className="min-w-0 truncate text-12 text-ink-3">{account}</span>
                      )}
                    </span>
                    {item.status === "error" && (
                      <span data-usage-error title="Couldn't read usage" className="flex shrink-0 text-red-ink">
                        <Icon icon={Alert02Icon} size={12} />
                      </span>
                    )}
                  </div>
                  <UsageWindows usage={item} now={now} dense />
                </section>
              );
            })}
            <div className="flex items-center gap-2 border-t border-line pb-0.5 pl-2 pt-1">
              <p className="min-w-0 flex-1 truncate text-11 text-ink-3">{updatedAt ? formatUpdatedAgo(updatedAt, now) : "Not updated yet"}</p>
              <IconButton
                size={24}
                label="Refresh plan usage"
                data-usage-refresh=""
                onClick={() => {
                  if (!spin.busy) spin.refresh();
                }}
                aria-disabled={spin.busy}
              >
                <span
                  className={`flex ${spin.spinning ? "refresh-spin animate-spin" : ""}`}
                  onAnimationIteration={spin.onAnimationIteration}
                  onAnimationEnd={spin.onAnimationEnd}
                >
                  <Icon icon={RefreshIcon} size={14} />
                </span>
              </IconButton>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}
