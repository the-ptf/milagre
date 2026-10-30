import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./Icon";

/**
 * Chip looks, all 28px, fully round, 12 medium:
 * - `trigger` (composer chips: Run on, Isolation, model, permission): transparent ink-2; hover fill and ink; open
 *   (aria-expanded) hover-2 and ink.
 * - `field`: a trigger on the field fill (the Routine form's chips, Select's chip variant): ink on hover, hover-2 open.
 * - `filter`: one of a radiogroup's choices (the Routines filters): surface with shadow-btn and ink-2, or ink fill with
 *   an on-ink semibold label when checked (the phone Chip's look).
 * - `static`: a field-filled tag that does nothing.
 */
const VARIANTS = {
  trigger: "text-ink-2 not-disabled:hover:bg-hover not-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink",
  field: "bg-field text-ink-2 not-disabled:hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink",
  filter:
    "bg-surface text-ink-2 shadow-btn not-disabled:hover:text-ink aria-checked:bg-ink aria-checked:font-semibold aria-checked:text-on-ink aria-checked:shadow-none",
  static: "bg-field text-ink-2",
} as const;
export type ChipVariant = keyof typeof VARIANTS;

/** A Chip's classes, for a trigger that must be another element (a Radix trigger with asChild). */
export function chipClass({ variant = "trigger", chevron = false }: { variant?: ChipVariant; chevron?: boolean } = {}) {
  return `inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full text-12 font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-40 aria-invalid:ring-1 aria-invalid:ring-red ${chevron ? "pr-2 pl-2.5" : "px-2.5"} ${VARIANTS[variant]}`;
}

/** The ink-3 12px chevron a trigger chip ends with. */
export function ChipChevron() {
  return <Icon icon={ArrowDown01Icon} size={12} className="shrink-0 text-ink-3" />;
}

/**
 * A 28px pill (see chipClass for the looks). `icon` is a 14px glyph or a node (a provider logo). `chevron` marks a
 * trigger that opens something; set aria-expanded on it while open. `filter` chips are role="radio" with `checked`;
 * wrap them in a role="radiogroup" with `onKeyDown={radioKeys()}`. `invalid` rings it in red. data-* and aria-* pass
 * through; `className` is for layout only.
 */
export function Chip({
  variant = "trigger",
  icon,
  chevron = false,
  checked,
  invalid = false,
  className = "",
  type = "button",
  children,
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ChipVariant;
  icon?: IconSvgElement | ReactNode;
  chevron?: boolean;
  /** A filter chip's state. */
  checked?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const classes = `${chipClass({ variant, chevron })} ${className}`;
  const content = (
    <>
      {icon !== undefined && (Array.isArray(icon) ? <Icon icon={icon as IconSvgElement} size={14} className="shrink-0" /> : icon)}
      {children}
      {chevron && <ChipChevron />}
    </>
  );
  if (variant === "static")
    return (
      <span {...(props as HTMLAttributes<HTMLSpanElement>)} className={classes}>
        {content}
      </span>
    );
  return (
    <button
      ref={ref}
      type={type}
      role={variant === "filter" ? "radio" : undefined}
      aria-checked={variant === "filter" ? !!checked : undefined}
      aria-invalid={invalid || undefined}
      {...props}
      className={classes}
    >
      {content}
    </button>
  );
}
