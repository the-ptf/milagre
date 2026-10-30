import type { InputHTMLAttributes, ReactNode, Ref } from "react";

const BOX =
  "w-full rounded-control border border-line-strong bg-field text-ink transition-colors placeholder:text-ink-3 focus:border-accent aria-invalid:not-focus:border-red disabled:opacity-40";
const SIZES = { 28: "h-7 px-2 text-12", 32: "h-8 px-2.5 text-13", 36: "h-9 px-2.5 text-13" } as const;
export type FieldSize = keyof typeof SIZES;

/**
 * A text field's classes at one of three densities: 36 in forms and dialogs, 32 in a toolbar or beside 32px buttons,
 * 28 in a compact row (12px text). Field fill, line-strong border, accent border on focus, red with aria-invalid
 * (focus wins while focused); put an InlineError size 12 under an invalid one.
 */
export function fieldClass({ size = 36 }: { size?: FieldSize } = {}) {
  return `${BOX} ${SIZES[size]}`;
}

/** A 36px text field's classes. */
export const FIELD = fieldClass();
/** The same box for a textarea (set its rows) or a wrapper around an input and its icons, which takes focus-within. */
export const FIELD_AREA = `${BOX} px-2.5 py-2 text-13 focus-within:border-accent`;
/**
 * The input inside a box that draws the field (FieldGroup, a bordered row or card): no fill, edge or outline of its
 * own, so the wrapper's focus-within edge is the only focus mark.
 */
export const FIELD_INNER = "h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-3";
/** A field's label or a fieldset's legend: 12 medium ink-2, 4px above the field (`grid gap-1` or `mb-1`). */
export const FIELD_LABEL = "text-12 font-medium text-ink-2";

/** A single-line text input on fieldClass, 36 unless `size` says otherwise. */
export function Input({
  size = 36,
  className = "",
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: FieldSize; ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} className={`${fieldClass({ size })} ${className}`} />;
}

/**
 * A text input with an icon, prefix, suffix or button inside it. The wrapper is the field: it draws the box and turns
 * accent on focus-within, so focus outlines the adornments too, never the text alone.
 */
export function FieldGroup({
  size = 36,
  leading,
  trailing,
  className = "",
  inputClassName = "",
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: FieldSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <label className={`${fieldClass({ size })} flex items-center gap-2 focus-within:border-accent has-[input:disabled]:opacity-40 ${className}`}>
      {leading}
      <input ref={ref} {...props} className={`${FIELD_INNER} ${inputClassName}`} />
      {trailing}
    </label>
  );
}
