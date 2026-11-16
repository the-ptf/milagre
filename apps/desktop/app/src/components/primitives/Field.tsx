import type { InputHTMLAttributes, ReactNode, Ref } from "react";

const BOX = "w-full rounded-control border text-ink transition-colors placeholder:text-ink-3 aria-invalid:not-focus:border-red disabled:opacity-40";
const SIZES = {
  28: "h-7 px-2 text-12",
  32: "h-8 px-2.5 text-13",
  36: "h-9 px-2.5 text-13",
} as const;
export type FieldSize = keyof typeof SIZES;

/**
 * A text field's classes at one of three densities: 36 in forms and dialogs, 32 in a toolbar or beside 32px buttons,
 * 28 in a compact row (12px text). Field fill, line-strong border, no focus edge (the caret shows focus), red with
 * aria-invalid while not focused; put an InlineError size 12 under an invalid one.
 */
const FILLS = { field: "border-line-strong bg-field", bare: "border-transparent bg-transparent" } as const;
export type FieldFill = keyof typeof FILLS;

export function fieldClass({ size = 36, fill = "field" }: { size?: FieldSize; fill?: FieldFill } = {}) {
  return `${BOX} ${FILLS[fill]} ${SIZES[size]}`;
}

export const FIELD = fieldClass();
/** The same box for a textarea (set its rows) or a wrapper around an input and its icons, with no focus edge. */
export const FIELD_AREA = `${BOX} ${FILLS.field} px-2.5 py-2 text-13`;
export const FIELD_INNER = "h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-3";
export const FIELD_LABEL = "text-12 font-medium text-ink-2";

export function Input({
  size = 36,
  className = "",
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: FieldSize;
  ref?: Ref<HTMLInputElement>;
}) {
  return <input ref={ref} {...props} className={`${fieldClass({ size })} ${className}`} />;
}

export function FieldGroup({
  size = 36,
  fill = "field",
  leading,
  trailing,
  className = "",
  inputClassName = "",
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: FieldSize;
  fill?: FieldFill;
  leading?: ReactNode;
  trailing?: ReactNode;
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <label
      className={`${fieldClass({ size, fill })} flex items-center gap-2 has-[input[aria-invalid=true]:not(:focus)]:border-red has-[input:disabled]:opacity-40 ${className}`}
    >
      {leading}
      <input ref={ref} {...props} className={`${FIELD_INNER} ${inputClassName}`} />
      {trailing}
    </label>
  );
}
