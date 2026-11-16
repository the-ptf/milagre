import { createContext, use, useId, useMemo, type HTMLAttributes, type InputHTMLAttributes } from "react";
import { CHECK_BOX } from "./Checkbox";

const Group = createContext<{ name: string; value?: string; onValueChange?: (value: string) => void; disabled?: boolean } | null>(null);

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

export function RadioGroupItem({
  value,
  className = "",
  tone: _tone,
  disabled,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "checked" | "onChange"> & {
  value: string;
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
