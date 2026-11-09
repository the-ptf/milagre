import type { ReactNode } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";

/**
 * The label over a group of rows: sentence case, no tracking, medium ink-3. 12px over a page or panel section (as
 * Settings' and Routines' groups), 11px inside a menu or picker (MenuLabel insets it). Write the text in sentence
 * case; nothing here uppercases it. `icon` puts a 14px ink-3 glyph before it (Routines' groups).
 */
export function SectionLabel({
  as: Tag = "h2",
  variant = "section",
  icon,
  id,
  className = "",
  children,
}: {
  as?: "h2" | "h3" | "h4" | "p" | "div" | "span" | "legend";
  variant?: "section" | "menu";
  icon?: IconSvgElement;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag id={id} className={`${variant === "menu" ? "text-11" : "text-12"} font-medium text-ink-3 ${icon ? "flex items-center gap-1.5" : ""} ${className}`}>
      {icon && <Icon icon={icon} size={14} className="shrink-0" />}
      {children}
    </Tag>
  );
}
