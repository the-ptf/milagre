import type { ReactNode } from "react";

/**
 * A ring that fills clockwise from the top with a download's progress (0..1), around whatever sits inside it: the dropping
 * arrow on the mic, a cancel cross in Settings.
 */
export function DownloadRing({ size, stroke = 2, progress, children }: { size: number; stroke?: number; progress: number; children?: ReactNode }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, progress));
  return (
    <span aria-hidden className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)}
          className="transition-[stroke-dashoffset] duration-200 ease-linear"
          // A round cap draws a dot at zero; hide the arc until something has arrived.
          opacity={filled > 0 ? 1 : 0}
        />
      </svg>
      {children}
    </span>
  );
}

/** The arrow that keeps dropping through the ring while the speech model downloads. */
export function DroppingArrow({ size, well }: { size: number; well: number }) {
  return (
    <span className="relative flex items-center justify-center overflow-hidden rounded-full" style={{ width: well, height: well }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="download-drop"
      >
        <path d="M12 4v15M6 13l6 6 6-6" />
      </svg>
    </span>
  );
}
