import type { ReactNode } from "react";

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
