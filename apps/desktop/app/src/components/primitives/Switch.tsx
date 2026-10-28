/** An on/off switch: ink when on, or the theme accent with `tone="accent"` (Babysit PRs). */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  tone = "ink",
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  tone?: "ink" | "accent";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex h-5 w-8 items-center rounded-full transition-colors duration-150 disabled:opacity-40 ${checked ? (tone === "accent" ? "bg-accent" : "bg-ink") : "bg-line-strong"}`}
    >
      <span
        className={`absolute left-0.5 size-4 rounded-full bg-surface shadow-card transition-transform duration-150 ${checked ? "translate-x-3" : "translate-x-0"}`}
      />
    </button>
  );
}
