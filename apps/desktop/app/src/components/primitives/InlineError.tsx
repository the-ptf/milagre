import type { ReactNode } from "react";

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
