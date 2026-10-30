import { useEffect, useId, useRef, useState, type AriaAttributes, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "./Button";
import { ScrollArea } from "./ScrollArea";

/**
 * A modal dialog: a native <dialog> opened with showModal, on the shared scrim, `rounded-window shadow-overlay`, at
 * most min(88vh, 760px) tall. A header (17 semibold title, 13 ink-2 description wired to aria-describedby, and with
 * `onClose` a 28px × at top right), a scrolling body, and the actions: inline at the bottom right, or with
 * `footer="bar"` in an inset bar under a body that scrolls. Mount it only while open; on unmount focus goes back to
 * what had it before. With `onClose`, the ×, Esc and a press on the scrim close it; without, it stays until its own
 * actions unmount it (an alertdialog that must be answered). The body starts right under the header, so its first
 * child sets the gap (`mt-3`, or `mt-4` before a group).
 */
const FRAME = "relative flex max-h-[min(88vh,760px)] flex-col";

export function Dialog({
  title,
  description,
  actions,
  footer = "inline",
  footerStart,
  onClose,
  onEscape = onClose,
  dismissOnScrim = true,
  closeLabel = "Close",
  as = "div",
  onSubmit,
  width = 440,
  role = "dialog",
  className = "",
  children,
  ...attributes
}: {
  title: ReactNode;
  /** A line under the title, in ink-2; it's the dialog's description for assistive tech. */
  description?: ReactNode;
  /** The buttons, right-aligned: Cancel (ghost) first, the primary last. */
  actions?: ReactNode;
  /** `inline` under the content (default), or `bar`: a bordered inset strip, for a body that scrolls. */
  footer?: "inline" | "bar";
  /** With `footer="bar"`, content at the bar's left (a status, a secondary link). */
  footerStart?: ReactNode;
  onClose?: () => void;
  /** Esc; defaults to onClose. Give it a different answer (Deny) or a no-op to keep Esc from closing. */
  onEscape?: () => void;
  /** Whether a press on the scrim closes it (default true); false while a form is busy or must be answered. */
  dismissOnScrim?: boolean;
  /** The ×'s name. */
  closeLabel?: string;
  /** `form` makes header, body and footer one form, so Enter and a submit button work; onSubmit gets the event, already prevented. */
  as?: "div" | "form";
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  width?: number;
  role?: "dialog" | "alertdialog";
  /** Extra classes for the body (a flex column for a growing textarea). */
  className?: string;
  children?: ReactNode;
} & AriaAttributes & { [key: `data-${string}`]: string | boolean | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // What had focus before it opened, read on the first render (before showModal moves focus in).
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // A press that starts in the content and ends on the scrim (a text drag out of a textarea) isn't a press on the scrim.
  const downInside = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node?.open) node?.showModal();
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || node?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  const bar = footer === "bar";
  const content = (
    <>
      <div className={`shrink-0 pt-5 pl-5 ${onClose ? "pr-12" : "pr-5"}`}>
        <h2 id={titleId} className="text-17 font-semibold">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-1 text-13 text-ink-2">
            {description}
          </p>
        )}
      </div>
      <ScrollArea className={`min-h-0 flex-1 px-5 ${actions && !bar ? "" : "pb-5"} ${className}`}>{children}</ScrollArea>
      {actions &&
        (bar ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-line bg-inset px-5 py-3">
            {footerStart}
            <div className="ml-auto flex gap-2">{actions}</div>
          </div>
        ) : (
          <div className="flex shrink-0 justify-end gap-2 p-5">{actions}</div>
        ))}
      {/* Last in the DOM, so showModal's first focus lands in the content, not on the ×; Esc is its keyboard path. */}
      {onClose && (
        // A wrapper takes the position: IconButton is `relative` for its hit area, which would beat `absolute`.
        <span className="absolute top-4 right-3.5 flex">
          <IconButton label={closeLabel} icon={Cancel01Icon} size={28} tooltip={false} onClick={onClose} />
        </span>
      )}
    </>
  );
  return createPortal(
    <dialog
      ref={dialog}
      role={role}
      aria-labelledby={attributes["aria-label"] ? undefined : titleId}
      aria-describedby={description ? descriptionId : undefined}
      {...attributes}
      onCancel={(event) => {
        event.preventDefault();
        onEscape?.();
      }}
      onPointerDown={(event) => {
        downInside.current = event.target !== dialog.current;
      }}
      onClick={(event) => {
        // The dialog element itself is only hit outside the content: a press on the scrim.
        if (dismissOnScrim && !downInside.current && event.target === dialog.current) onClose?.();
        downInside.current = false;
      }}
      className="m-auto max-w-[calc(100vw-32px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
      // `backwards`, so no transform stays on the dialog once it has popped in: a transform would make it the
      // containing block of a fixed tooltip or picker inside it.
      style={{ width, animation: "pop-in var(--duration-base) var(--ease-enter) backwards" }}
    >
      {as === "form" ? (
        <form
          className={FRAME}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit?.(event);
          }}
        >
          {content}
        </form>
      ) : (
        <div className={FRAME}>{content}</div>
      )}
    </dialog>,
    document.body,
  );
}
