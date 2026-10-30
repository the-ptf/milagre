import type { ButtonHTMLAttributes } from "react";

/**
 * An on/off switch: ink when on. Off is the pale macOS track, ink-4 under Increase Contrast (3:1). Other button
 * attributes (aria-controls, aria-expanded, data-*) pass through.
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  tone: _tone,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** @deprecated Switches are ink (round 2, decision 19); remove it from call sites. */
  tone?: "ink" | "accent";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      {...props}
      onClick={() => onChange(!checked)}
      className={`relative flex h-5 w-8 shrink-0 items-center rounded-full transition-colors before:absolute before:-inset-y-0.5 before:inset-x-0 disabled:opacity-40 ${checked ? "bg-ink" : "bg-line-strong contrast-more:bg-ink-4"} ${className}`}
    >
      <span className={`absolute left-0.5 size-4 rounded-full bg-surface shadow-card transition-transform ${checked ? "translate-x-3" : "translate-x-0"}`} />
    </button>
  );
}
