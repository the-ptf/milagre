const TOAST_MS = 2600;
const ACTION_MS = 6000;
let element: HTMLDivElement | null = null;
let timer: number | undefined;

/** The toast's look, also for a hint that stays (the floating inbox's drag hint): an ink capsule, on-ink 13. */
export const TOAST = "flex items-center gap-3 rounded-card bg-ink px-4 py-2 text-13 text-on-ink shadow-raised";

export type ToastOptions = {
  /** An on-ink action after the text (Undo). The toast then stays 6s, and pressing it closes the toast. */
  action?: { label: string; onClick: () => void; attribute?: `data-${string}` };
  /** A data attribute for the toast besides data-toast (tests, e.g. data-chat-toast). */
  attribute?: `data-${string}`;
};

/**
 * Shows a short confirmation at the bottom centre of the window (above the composer in a Chat): an ink capsule that fades up and leaves after 2.6s.
 * The toast is a manual popover in the top layer, and showing it again moves it to the top, so a toast from a modal
 * dialog (also in the top layer) appears over the dialog, not under its backdrop. One at a time: a new one replaces it.
 */
export function showToast(text: string, { action, attribute }: ToastOptions = {}) {
  // Out of the document when hidden: `flex` would otherwise override the hidden popover's display:none.
  element?.remove();
  const toast = document.createElement("div");
  toast.popover = "manual";
  toast.role = "status";
  toast.ariaLive = "polite";
  toast.dataset.toast = "";
  if (attribute) toast.setAttribute(attribute, "");
  toast.className = `fixed inset-auto bottom-4 left-1/2 m-0 max-w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 overflow-visible border-0 ${TOAST}`;
  toast.style.animation = "fade-up var(--duration-base) var(--ease-enter) both";
  const line = document.createElement("span");
  line.textContent = text;
  toast.append(line);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shrink-0 font-medium text-on-ink hover:underline";
    button.textContent = action.label;
    if (action.attribute) button.setAttribute(action.attribute, "");
    button.addEventListener("click", () => {
      toast.remove();
      action.onClick();
    });
    toast.append(button);
  }
  // Over a Chat it sits above the composer (the focused one when there are several), never over its text.
  const composer =
    [...document.querySelectorAll<HTMLElement>("[data-composer-wrap]")].find((el) => el.contains(document.activeElement)) ??
    document.querySelector<HTMLElement>("[data-composer-wrap]");
  const rect = composer?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    toast.style.bottom = `${innerHeight - rect.top + 8}px`;
    toast.style.left = `${rect.left + rect.width / 2}px`;
  }
  document.body.append(toast);
  element = toast;
  toast.showPopover();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => toast.remove(), action ? ACTION_MS : TOAST_MS);
}
