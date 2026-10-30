import type { InputHTMLAttributes, Ref } from "react";

const BOX =
  "w-full rounded-control border border-line-strong bg-field px-2.5 text-13 text-ink transition-colors duration-fast placeholder:text-ink-3 focus:border-accent disabled:opacity-40";

/** A 36px text field's classes: field fill, line-strong border, accent border on focus. */
export const FIELD = `${BOX} h-9`;
/** The same box for a textarea (set its rows) or a wrapper around an input and its icons, which takes focus-within. */
export const FIELD_AREA = `${BOX} py-2 focus-within:border-accent`;

/** A single-line text input on FIELD. */
export function Input({ className = "", ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} {...props} className={`${FIELD} ${className}`} />;
}
