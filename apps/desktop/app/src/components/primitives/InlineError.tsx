import type { ReactNode } from "react";

/** A failure in place, under the control or form it belongs to: red-ink text announced as an alert. Renders nothing when empty. */
export function InlineError({
  children,
  size = 13,
  className = "",
  ...data
}: { children?: ReactNode; size?: 12 | 13; className?: string } & { [key: `data-${string}`]: string | boolean | undefined }) {
  if (!children) return null;
  return (
    <p {...data} role="alert" className={`break-words ${size === 12 ? "text-12" : "text-13"} text-red-ink ${className}`}>
      {children}
    </p>
  );
}
