import type { ReactNode } from "react";

/** A dismissable notice card, above the composer or over a view: a line of text, or a list. `className` sets its outer spacing and width. */
export function Notice({
  children,
  onDismiss,
  action,
  className = "mb-2",
  ...data
}: { children: ReactNode; onDismiss?: () => void; action?: ReactNode; className?: string } & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <div
      role="status"
      data-notice
      {...data}
      className={`${className} flex w-full items-center justify-between gap-3 rounded-[12px] border border-line bg-surface px-4 py-2.5 text-[13px] leading-snug text-ink shadow-overlay`}
      style={{ animation: "fade-up 250ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" data-notice-dismiss onClick={onDismiss} className="shrink-0 text-xs font-medium text-ink-3 transition-colors hover:text-ink">
          Dismiss
        </button>
      )}
    </div>
  );
}
