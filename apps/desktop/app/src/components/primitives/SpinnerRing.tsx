export function SpinnerRing({ size, stroke = 2, color = "var(--ink-3)" }: { size: number; stroke?: number; color?: string }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    // 15 steps of 80 ms, the running logo's beat (styles.css). Chromium draws a stepped animation only as often as its
    <span aria-hidden className="spinner-ring inline-flex shrink-0" style={{ width: size, height: size, animation: "spin 1.2s steps(15) infinite" }}>
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
