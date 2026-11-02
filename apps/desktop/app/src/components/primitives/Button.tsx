import { useMemo, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon, type IconSize } from "./Icon";
import { chainHandlers, mergeRefs, useInTooltip, useTooltip } from "./Tooltip";

/**
 * One primary style: ink fill, on-ink label. Accent is for focus and links, never a filled button. Filled variants
 * (primary, danger) press to 0.97; the others darken on hover only. Hovers and presses skip a disabled control and
 * one marked aria-disabled; `not-disabled:` rather than `enabled:`, so an anchor drawn with buttonClass() hovers too.
 */
const VARIANTS = {
  primary: "bg-ink text-on-ink not-disabled:not-aria-disabled:hover:opacity-90 not-disabled:not-aria-disabled:active:scale-press",
  secondary: "bg-surface text-ink shadow-btn not-disabled:not-aria-disabled:hover:bg-hover",
  ghost: "text-ink not-disabled:not-aria-disabled:hover:bg-hover",
  /** Muted ghost: ink-2, ink on hover. */
  quiet: "text-ink-2 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink",
  /** An inline action in accent-ink (Fix in Chat, a text link that acts). */
  link: "text-accent-ink not-disabled:not-aria-disabled:hover:bg-hover",
  /** The confirm of a destructive action: red-ink fill, so the label reaches 4.5:1. */
  danger: "bg-red-ink text-on-red not-disabled:not-aria-disabled:hover:opacity-90 not-disabled:not-aria-disabled:active:scale-press",
  /** The first step of a destructive action (Remove, Delete, Deny, Revoke, Stop): red-ink text, red-tint on hover. */
  "danger-ghost": "text-red-ink not-disabled:not-aria-disabled:hover:bg-red-tint",
} as const;
export type ButtonVariant = keyof typeof VARIANTS;

const SIZES = { 24: "h-6 px-2 text-12", 28: "h-7 px-2.5 text-12", 32: "h-8 px-3 text-13" } as const;
export type ButtonSize = keyof typeof SIZES;
export type ButtonShape = "control" | "pill";

// Focus is the base accent outline (styles.css); disabled is 40% on every control, aria-disabled included.
const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-[color,background-color,opacity,scale] duration-fast ease-enter disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40";
const SHAPES = { control: "rounded-control", pill: "rounded-full not-disabled:not-aria-disabled:active:scale-press" } as const;

/** The classes of a Button, for an element that must look like one (a link, a Radix trigger with asChild). */
export function buttonClass({ variant = "primary", size = 32, shape = "control" }: { variant?: ButtonVariant; size?: ButtonSize; shape?: ButtonShape } = {}) {
  return `${BASE} ${SHAPES[shape]} ${SIZES[size]} ${VARIANTS[variant]}`;
}

/**
 * A text button: 32 by default, 28 in compact rows and composer chips, 24 inline. `shape="pill"` rounds it fully (and
 * it presses). `className` is for layout only (margin, flex, width, position), never colour, size or radius. Prefer
 * `aria-disabled` over `disabled` when the reason should stay reachable (a Tooltip on it); the click handler then
 * has to ignore it.
 */
export function Button({
  variant = "primary",
  size = 32,
  shape = "control",
  className = "",
  type = "button",
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button ref={ref} type={type} {...props} className={`${buttonClass({ variant, size, shape })} ${className}`} />;
}

const ICON_SIZES = { 20: "size-5 before:absolute before:-inset-0.5", 24: "size-6", 28: "size-7", 32: "size-8" } as const;
const GLYPH: Record<keyof typeof ICON_SIZES, IconSize> = { 20: 12, 24: 14, 28: 16, 32: 16 };

// A pressed (aria-pressed) or open (aria-expanded) toggle is hover-2 with an ink glyph; these sort after the hover
// classes, so hovering never weakens it. `tone="accent"` is only for an armed mode that changes what a click does.
const ICON_LOOKS = {
  ghost:
    "text-ink-3 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink aria-pressed:bg-hover-2 aria-pressed:text-ink",
  accent:
    "text-ink-3 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink aria-pressed:bg-accent-tint aria-pressed:text-accent-ink",
  "danger-ghost": "text-ink-3 not-disabled:not-aria-disabled:hover:bg-red-tint not-disabled:not-aria-disabled:hover:text-red-ink",
} as const;

/**
 * A square icon-only button. `label` is its accessible name and, by default, its Tooltip (`tooltip={false}` for a
 * dialog's ×, or where a Tooltip around it already says more; `shortcut` and `side` go to the Tooltip). Ghost is
 * ink-3 at rest, ink on hover, and hover-2 with an ink glyph while `aria-pressed` or `aria-expanded` is true. A 20px
 * button reaches the 24px hit-area floor through its ::before, so keep 2px clear of its neighbours.
 */
export function IconButton({
  label,
  icon,
  iconSize,
  size = 28,
  variant = "ghost",
  tone = "ink",
  shape = "control",
  tooltip = true,
  shortcut,
  side,
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
  /** The pressed look: ink (hover-2), or accent for an armed mode (comment mode). */
  tone?: "ink" | "accent";
  shape?: ButtonShape;
  /** Show `label` as a Tooltip (default). */
  tooltip?: boolean;
  shortcut?: string;
  side?: "top" | "bottom";
  /** Custom content in place of `icon` (a spinner, a provider logo). */
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  const wrapped = useInTooltip();
  const tip = useTooltip({ label, shortcut, side }, tooltip && !wrapped);
  const merged = useMemo(() => mergeRefs<HTMLButtonElement>(ref, tip.ref as Ref<HTMLButtonElement>), [ref, tip.ref]);
  const look =
    variant === "ghost" ? ICON_LOOKS[tone === "accent" ? "accent" : "ghost"] : variant === "danger-ghost" ? ICON_LOOKS["danger-ghost"] : VARIANTS[variant];
  return (
    <>
      <button
        ref={merged}
        type={type}
        aria-label={label}
        {...props}
        {...(tip.layers ? chainHandlers(props, tip.handlers) : {})}
        className={`${BASE} relative ${shape === "pill" ? "rounded-full" : "rounded-control"} ${ICON_SIZES[size]} not-disabled:not-aria-disabled:active:scale-press ${look} ${className}`}
      >
        {children ?? (icon && <Icon icon={icon} size={iconSize ?? GLYPH[size]} />)}
      </button>
      {tip.layers}
    </>
  );
}
