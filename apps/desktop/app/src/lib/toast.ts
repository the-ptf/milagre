const TOAST_MS = 2600;

/**
 * Every toast's look, matching the phone's ToastPill: an ink pill with its icon, text and Undo in the label colour.
 * Status colours and the accent fall under 3:1 on ink in some themes, so an icon says what happened by its shape alone.
 * No display here: on the popover below, one would override the browser's `display: none` for a closed popover.
 */
const TOAST_CLASS = "fixed z-[80] min-h-10 max-w-[min(520px,calc(100vw-2rem))] rounded-full bg-ink px-4 py-2 text-13 font-medium text-surface shadow-overlay";
let element: HTMLDivElement | null = null;
let timer: number | undefined;

/**
 * Shows a short confirmation at the bottom of the window. The toast is a manual popover in the top layer, and showing it
 * again moves it to the top, so a toast from a modal dialog (also in the top layer) appears over the dialog, not under
 * its backdrop.
 */
export function showToast(text: string) {
  if (!element?.isConnected) {
    element = document.createElement("div");
    element.popover = "manual";
    element.role = "status";
    element.ariaLive = "polite";
    element.dataset.toast = "";
    element.className = `${TOAST_CLASS} inset-auto bottom-4 left-1/2 m-0 -translate-x-1/2 overflow-visible border-0`;
    document.body.append(element);
  }
  const toast = element;
  const line = document.createElement("span");
  line.className = "block leading-6";
  line.style.animation = "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both";
  line.textContent = text;
  toast.replaceChildren(line);
  if (toast.matches(":popover-open")) toast.hidePopover();
  toast.showPopover();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => toast.hidePopover(), TOAST_MS);
}
