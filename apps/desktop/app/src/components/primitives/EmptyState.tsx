import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";

const PADDING = { compact: "px-3 py-6", panel: "px-6 py-10", page: "px-6 py-16" } as const;

/**
 * What a list or panel shows with nothing in it, centred: an optional icon, a title, a line of help and an action.
 * `panel` (default) suits a panel, `page` a whole page, `compact` a list or menu (one 12 ink-3 line, no icon, role
 * status). `className` replaces the size's padding, so pass the whole padding when you change it. Titles have no full
 * stop; help lines end with one.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  size = "panel",
  className,
  ...data
}: {
  icon?: IconSvgElement;
  title?: ReactNode;
  /** The help line, in ink-3. */
  children?: ReactNode;
  /** A Button (secondary or ghost; the screen's primary stays where it is). */
  action?: ReactNode;
  size?: keyof typeof PADDING;
  /** Outer spacing, in place of the size's padding. */
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const compact = size === "compact";
  return (
    <div
      {...data}
      role={compact ? "status" : undefined}
      className={`flex flex-col items-center justify-center gap-1 text-center ${className ?? PADDING[size]}`}
    >
      {icon && !compact && (
        <span className="mb-1 text-ink-4">
          <Icon icon={icon} size={18} />
        </span>
      )}
      {title && <p className={compact ? "text-12 text-ink-3" : "text-13 font-medium text-ink"}>{title}</p>}
      {children && <p className="max-w-80 text-12 text-ink-3">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
