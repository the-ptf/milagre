const TOAST_MS = 2600;
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
    element.className =
      "fixed inset-auto bottom-4 left-1/2 m-0 max-w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 overflow-visible rounded-[10px] border-0 bg-surface px-3 py-2 text-[13px] text-ink shadow-overlay";
    document.body.append(element);
  }
  const toast = element;
  const line = document.createElement("span");
  line.className = "block";
  line.style.animation = "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both";
  line.textContent = text;
  toast.replaceChildren(line);
  if (toast.matches(":popover-open")) toast.hidePopover();
  toast.showPopover();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => toast.hidePopover(), TOAST_MS);
}
