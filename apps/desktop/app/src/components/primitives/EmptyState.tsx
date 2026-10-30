import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";

/** What a list or panel shows with nothing in it: an optional icon, a title, a line of help and an action, centred. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className = "",
  ...data
}: {
  icon?: IconSvgElement;
  title?: ReactNode;
  /** The help line, in ink-3. */
  children?: ReactNode;
  /** A Button (secondary or ghost; the screen's primary stays where it is). */
  action?: ReactNode;
  /** Outer spacing; the default suits a panel. */
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    <div {...data} className={`flex flex-col items-center justify-center gap-1 px-6 py-10 text-center ${className}`}>
      {icon && (
        <span className="mb-1 text-ink-4">
          <Icon icon={icon} size={18} />
        </span>
      )}
      {title && <p className="text-13 font-medium text-ink">{title}</p>}
      {children && <p className="max-w-80 text-12 text-ink-3">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
