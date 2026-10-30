import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A modal dialog: a native <dialog> opened with showModal, on the shared scrim, `rounded-window shadow-overlay`, a
 * 17 semibold title and an actions row at the bottom right. Mount it only while open. With `onClose`, Esc and a press
 * on the scrim close it; without, it stays until its own actions unmount it (an alertdialog that must be answered).
 */
export function Dialog({
  title,
  description,
  actions,
  onClose,
  width = 440,
  role = "dialog",
  className = "",
  children,
  ...data
}: {
  title: ReactNode;
  /** A line under the title, in ink-2. */
  description?: ReactNode;
  /** The buttons, right-aligned under the content: Cancel first, the primary last. */
  actions?: ReactNode;
  onClose?: () => void;
  width?: number;
  role?: "dialog" | "alertdialog";
  /** Extra classes for the content's padding box. */
  className?: string;
  children?: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      role={role}
      aria-labelledby={titleId}
      {...data}
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
      onClick={(event) => {
        // The dialog element itself is only hit outside the padded content: a press on the scrim.
        if (event.target === dialog.current) onClose?.();
      }}
      className="m-auto max-w-[calc(100vw-32px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
      style={{ width, animation: "pop-in var(--duration-base) var(--ease-enter) both" }}
    >
      <div className={`p-5 ${className}`}>
        <h2 id={titleId} className="text-17 font-semibold">
          {title}
        </h2>
        {description && <p className="mt-1 text-13 text-ink-2">{description}</p>}
        {children}
        {actions && <div className="mt-5 flex justify-end gap-2">{actions}</div>}
      </div>
    </dialog>,
    document.body,
  );
}
