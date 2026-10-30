import type { ReactNode } from "react";

/**
 * The label over a group of rows: sentence case, no tracking, medium ink-3. 12px over a page or panel section (as
 * Settings' groups), 11px inside a menu or picker. Write the text in sentence case; nothing here uppercases it.
 */
export function SectionLabel({
  as: Tag = "h2",
  variant = "section",
  id,
  className = "",
  children,
}: {
  as?: "h2" | "h3" | "h4" | "p" | "div" | "span" | "legend";
  variant?: "section" | "menu";
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag id={id} className={`${variant === "menu" ? "text-11" : "text-12"} font-medium text-ink-3 ${className}`}>
      {children}
    </Tag>
  );
}
