import { createContext, use, useId, useMemo, type HTMLAttributes, type InputHTMLAttributes } from "react";
import { CHECK_BOX } from "./Checkbox";

const Group = createContext<{ name: string; value?: string; onValueChange?: (value: string) => void; disabled?: boolean } | null>(null);

/**
 * A radio group on real <input type="radio">s sharing one name, so the arrow keys move and pick, and a <label>
 * around each works. Same API as the Radix one it replaces: `value`, `onValueChange`, RadioGroupItem children.
 */
export function RadioGroup({
  value,
  onValueChange,
  name,
  disabled,
  orientation,
  className = "",
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  value?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
}) {
  const id = useId();
  const group = useMemo(() => ({ name: name ?? id, value, onValueChange, disabled }), [name, id, value, onValueChange, disabled]);
  return (
    <div role="radiogroup" aria-orientation={orientation} {...props} className={`grid gap-3 ${className}`}>
      <Group value={group}>{children}</Group>
    </div>
  );
}

/**
 * A 16px radio: an ink-3 ring at rest, filled ink with an 8px on-ink dot when checked (like a checked checkbox). It
 * carries role, aria-checked and data-state as well, the hooks the Radix one had. Selection is ink: `tone` is ignored.
 */
export function RadioGroupItem({
  value,
  className = "",
  tone: _tone,
  disabled,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "checked" | "onChange"> & {
  value: string;
  /** @deprecated Selection is ink (round 2, decision 2); remove it from call sites. */
  tone?: "ink" | "accent";
}) {
  const group = use(Group);
  const checked = group?.value === value;
  return (
    <span className={`inline-grid shrink-0 place-items-center ${className}`}>
      <input
        type="radio"
        role="radio"
        name={group?.name}
        value={value}
        checked={checked}
        aria-checked={checked}
        data-state={checked ? "checked" : "unchecked"}
        disabled={disabled ?? group?.disabled}
        onChange={() => group?.onValueChange?.(value)}
        {...props}
        className={`${CHECK_BOX} rounded-full`}
      />
      <span aria-hidden className="pointer-events-none col-start-1 row-start-1 hidden size-2 rounded-full bg-on-ink peer-checked:block" />
    </span>
  );
}
