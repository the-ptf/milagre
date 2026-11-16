import { useMemo, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon, type IconSize } from "./Icon";
import { chainHandlers, mergeRefs, useInTooltip, useTooltip } from "./Tooltip";

const VARIANTS = {
  primary: "bg-ink text-on-ink not-disabled:not-aria-disabled:hover:opacity-90 not-disabled:not-aria-disabled:active:scale-press",
  secondary: "bg-surface text-ink shadow-btn not-disabled:not-aria-disabled:hover:bg-hover",
  ghost: "text-ink not-disabled:not-aria-disabled:hover:bg-hover",
  quiet: "text-ink-2 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink",
  link: "text-accent-ink not-disabled:not-aria-disabled:hover:bg-hover",
  danger: "bg-red-ink text-on-red not-disabled:not-aria-disabled:hover:opacity-90 not-disabled:not-aria-disabled:active:scale-press",
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

export function buttonClass({ variant = "primary", size = 32, shape = "control" }: { variant?: ButtonVariant; size?: ButtonSize; shape?: ButtonShape } = {}) {
  return `${BASE} ${SHAPES[shape]} ${SIZES[size]} ${VARIANTS[variant]}`;
}

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

const ICON_LOOKS = {
  ghost:
    "text-ink-3 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink aria-pressed:bg-hover-2 aria-pressed:text-ink",
  accent:
    "text-ink-3 not-disabled:not-aria-disabled:hover:bg-hover not-disabled:not-aria-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink aria-pressed:bg-accent-tint aria-pressed:text-accent-ink",
  "danger-ghost": "text-ink-3 not-disabled:not-aria-disabled:hover:bg-red-tint not-disabled:not-aria-disabled:hover:text-red-ink",
} as const;

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
  tone?: "ink" | "accent";
  shape?: ButtonShape;
  tooltip?: boolean;
  shortcut?: string;
  side?: "top" | "bottom";
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
