import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon, type IconSize } from "./Icon";

/** One primary style: ink fill, on-ink label. Accent is for focus, links and selection, never a filled button. */
const VARIANTS = {
  primary: "bg-ink text-on-ink enabled:hover:opacity-90",
  secondary: "bg-surface text-ink shadow-btn enabled:hover:bg-hover",
  ghost: "text-ink enabled:hover:bg-hover",
  danger: "bg-red text-on-red enabled:hover:opacity-90",
} as const;
export type ButtonVariant = keyof typeof VARIANTS | "ink";

const SIZES = { 24: "h-6 px-2 text-12", 28: "h-7 px-2.5 text-12", 32: "h-8 px-3 text-13" } as const;
export type ButtonSize = keyof typeof SIZES;

// Focus is the base accent outline (styles.css); disabled is 40% on every control.
const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap transition-[color,background-color,opacity,scale] duration-fast ease-enter disabled:cursor-default disabled:opacity-40";

/** The classes of a Button, for an element that must look like one (a link, a Radix trigger with asChild). */
export function buttonClass({ variant = "primary", size = 32 }: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant === "ink" ? "primary" : variant]}`;
}

/** A text button: 32 by default, 28 in compact rows and composer chips, 24 inline. */
export function Button({
  variant = "primary",
  size = 32,
  className = "",
  type = "button",
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} type={type} {...props} className={`${buttonClass({ variant, size })} ${className}`} />;
}

const ICON_SIZES = { 20: "size-5 before:absolute before:-inset-0.5", 24: "size-6", 28: "size-7", 32: "size-8" } as const;
const GLYPH: Record<keyof typeof ICON_SIZES, IconSize> = { 20: 12, 24: 14, 28: 16, 32: 16 };

/**
 * A square icon-only button. `label` is its accessible name (put a Tooltip around it for the visible one). A 20px button
 * reaches the 24px hit-area floor through its ::before, so keep 2px clear of its neighbours. Ghost is ink-3 at rest.
 */
export function IconButton({
  label,
  icon,
  iconSize,
  size = 28,
  variant = "ghost",
  className = "",
  type = "button",
  children,
  ref,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  icon?: IconSvgElement;
  iconSize?: IconSize;
  size?: keyof typeof ICON_SIZES;
  variant?: ButtonVariant;
  /** Custom content in place of `icon` (a spinner, a provider logo). */
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  const look = variant === "ghost" ? "text-ink-3 enabled:hover:bg-hover enabled:hover:text-ink" : VARIANTS[variant === "ink" ? "primary" : variant];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      {...props}
      className={`${BASE} relative ${ICON_SIZES[size]} enabled:active:scale-press ${look} ${className}`}
    >
      {children ?? (icon && <Icon icon={icon} size={iconSize ?? GLYPH[size]} />)}
    </button>
  );
}
