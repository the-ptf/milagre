const FILL = { ink: "bg-ink", green: "bg-green", orange: "bg-orange", red: "bg-red" } as const;

export function ProgressBar({
  value,
  tone = "ink",
  size = 4,
  label,
  valueText,
  className = "",
}: {
  value: number;
  tone?: keyof typeof FILL;
  size?: 4 | 6;
  label?: string;
  valueText?: string;
  className?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      {...(label
        ? { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent, "aria-valuetext": valueText }
        : { "aria-hidden": true })}
      className={`relative w-full shrink-0 overflow-hidden rounded-full bg-line-strong ${size === 6 ? "h-1.5" : "h-1"} ${className}`}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-slow motion-reduce:transition-none ${FILL[tone]}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
