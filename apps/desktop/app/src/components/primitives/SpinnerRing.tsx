/** A ring with an arc sweeping round it, as on the task rows: a turn is running. */
export function SpinnerRing({ size, stroke = 2, color = "var(--ink-3)" }: { size: number; stroke?: number; color?: string }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span aria-hidden className="spinner-ring inline-flex shrink-0" style={{ width: size, height: size, animation: "spin 1.1s steps(24) infinite" }}>
      <svg width={size} height={size} className="block">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference * 0.72}`}
        />
      </svg>
    </span>
  );
}
