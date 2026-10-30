import type { InputHTMLAttributes, Ref } from "react";

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
