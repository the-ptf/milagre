import type { InputHTMLAttributes, Ref } from "react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./Icon";

// The box both inputs draw: line ink-3 at rest, ink fill once checked. Inputs drop the base outline (styles.css), so
// the accent focus ring is put back here.
export const CHECK_BOX =
  "peer col-start-1 row-start-1 size-4 shrink-0 cursor-pointer appearance-none border border-ink-3 bg-surface transition-colors checked:border-ink checked:bg-ink indeterminate:border-ink indeterminate:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40 aria-invalid:border-red";

/**
 * A checkbox on a real <input type="checkbox">, so it's in the form, Space toggles it and a <label> around it works:
 * a 16px box, ink-filled with a 14px on-ink tick when checked. It carries role, aria-checked and data-state as well, the
 * hooks the Radix one had. `className` goes on the box's wrapper (margins). Selection is ink: `tone` is ignored.
 */
export function Checkbox({
  checked = false,
  onCheckedChange,
  className = "",
  tone: _tone,
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange"> & {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean) => void;
  /** @deprecated Selection is ink (round 2, decision 2); remove it from call sites. */
  tone?: "ink" | "accent";
  ref?: Ref<HTMLInputElement>;
}) {
  const mixed = checked === "indeterminate";
  const state = mixed ? "indeterminate" : checked ? "checked" : "unchecked";
  return (
    <span className={`inline-grid shrink-0 place-items-center ${className}`}>
      <input
        ref={(node) => {
          if (node) node.indeterminate = mixed;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="checkbox"
        role="checkbox"
        aria-checked={mixed ? "mixed" : checked}
        data-state={state}
        checked={checked === true}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
        className={`${CHECK_BOX} rounded-inline`}
      />
      <span aria-hidden className="pointer-events-none col-start-1 row-start-1 hidden text-on-ink peer-checked:flex">
        <Icon icon={Tick02Icon} size={14} />
      </span>
      <span aria-hidden className="pointer-events-none col-start-1 row-start-1 hidden h-0.5 w-2 rounded-full bg-on-ink peer-indeterminate:block" />
    </span>
  );
}

/**
 * The checkbox's (or with `radio`, the radio's) box alone, for a row that is itself the control (a menuitemcheckbox,
 * an option button): it draws the state, the row carries the role and aria-checked.
 */
export function CheckboxBox({ checked, radio = false, className = "" }: { checked: boolean; radio?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`flex size-4 shrink-0 items-center justify-center border transition-colors ${radio ? "rounded-full" : "rounded-inline"} ${checked ? "border-ink bg-ink text-on-ink" : "border-ink-3 bg-surface"} ${className}`}
    >
      {checked && (radio ? <span className="size-2 rounded-full bg-on-ink" /> : <Icon icon={Tick02Icon} size={14} />)}
    </span>
  );
}
