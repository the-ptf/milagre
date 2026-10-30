import type { ReactNode } from "react";

/**
 * A failure, announced as an alert; renders nothing when empty. Two tiers:
 * - `inline` (default): red-ink text under the control or form it belongs to, 12 in dialogs and under fields, 13
 *   standalone.
 * - `card`: a blocking failure with a way out (a Chat that won't load, a failed save): a red-tint card, 13 red-ink,
 *   with `action` (a secondary Button at 28) at its right. `floating`: the same message over a canvas or view, on a
 *   surface with shadow-raised, 12.
 */
export function InlineError({
  children,
  size = 13,
  variant = "inline",
  action,
  className = "",
  ...data
}: {
  children?: ReactNode;
  size?: 12 | 13;
  variant?: "inline" | "card" | "floating";
  /** With `card`: the retry, a `<Button variant="secondary" size={28}>`. */
  action?: ReactNode;
  className?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  if (!children) return null;
  if (variant === "card")
    return (
      <div {...data} role="alert" className={`flex items-center gap-3 rounded-card bg-red-tint p-3 text-13 text-red-ink ${className}`}>
        <p className="min-w-0 flex-1 break-words">{children}</p>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    );
  return (
    <p
      {...data}
      role="alert"
      className={`break-words text-red-ink ${variant === "floating" ? "rounded-card bg-surface px-3 py-2 text-12 shadow-raised" : size === 12 ? "text-12" : "text-13"} ${className}`}
    >
      {children}
    </p>
  );
}
