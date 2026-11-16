const TOAST_MS = 2600;

export const TOAST = "rounded-full bg-ink px-4 py-2 text-13 font-medium text-on-ink shadow-overlay";
const TOAST_CLASS = "fixed z-[80] min-h-10 max-w-[min(520px,calc(100vw-2rem))] rounded-full bg-ink px-4 py-2 text-13 font-medium text-on-ink shadow-overlay";
let element: HTMLDivElement | null = null;
let timer: number | undefined;

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
  line.style.animation = "fade-up 200ms cubic-bezier(0.23,1,0.32,1) backwards";
  line.textContent = text;
  toast.replaceChildren(line);
  if (toast.matches(":popover-open")) toast.hidePopover();
  toast.showPopover();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => toast.hidePopover(), TOAST_MS);
}
