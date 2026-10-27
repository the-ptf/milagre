import type { ReactNode } from "react";

/** A titled card of Settings rows. `action` sits at the right of the title (Babysit PRs' Reset all to defaults). */
export function Group({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between gap-4 px-1">
        <h2 className="text-[12px] font-medium text-ink-3">{title}</h2>
        {action}
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-[12px] bg-surface shadow-card">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  preview,
  children,
}: {
  label: string;
  description?: string;
  /** On Appearance: the row tells the window preview while the pointer is over it. */
  preview?: { onEnter: () => void; onLeave: () => void };
  children: ReactNode;
}) {
  return (
    <div
      data-preview-row={preview ? "" : undefined}
      onPointerEnter={preview?.onEnter}
      onPointerLeave={preview?.onLeave}
      className="flex min-h-12 items-center justify-between gap-6 px-4 py-2"
    >
      <div className="grid min-w-0 gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">{label}</span>
        {description && <span className="text-[12px] text-ink-3">{description}</span>}
      </div>
      <div className="shrink-0 text-[13px] text-ink-2">{children}</div>
    </div>
  );
}
