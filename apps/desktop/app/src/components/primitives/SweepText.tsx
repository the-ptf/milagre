import type { HTMLAttributes } from "react";

/**
 * A running step's title: the muted text with a brighter band sweeping across it. The band is a bright copy of the text
 * under a moving mask, animated with transform only (styles.css .sweep-band), so the compositor draws it: the old
 * background-position sweep repainted the title on the main thread every display frame. The copy is inert, so a file
 * link inside it is neither focusable nor announced twice.
 */
export function SweepText({ running, className = "", children, ...props }: HTMLAttributes<HTMLSpanElement> & { running: boolean }) {
  return (
    <span {...props} className={`relative ${className}`}>
      {children}
      {running && (
        <span aria-hidden inert className="sweep-band pointer-events-none absolute inset-y-0 select-none">
          <span className="sweep-band-counter block">
            <span className="sweep-band-copy block">{children}</span>
          </span>
        </span>
      )}
    </span>
  );
}
