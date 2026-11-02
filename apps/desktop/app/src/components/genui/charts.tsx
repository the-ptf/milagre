import type { ReactNode } from "react";
import { CHART_HEIGHT, CHART_PAD, CHART_WIDTH, chartGeometry } from "@milagre/shared/genui";
import type { GenuiProps } from "@milagre/shared/genui";

function Labels({ labels, slot }: { labels: readonly string[]; slot: number }) {
  // Only as many labels as fit at about 40px each; the rest stay in the tooltip of their bar or point.
  const every = Math.max(1, Math.ceil(40 / slot));
  return (
    <>
      {labels.map((label, index) =>
        index % every === 0 ? (
          <text key={index} x={CHART_PAD.left + slot * index + slot / 2} y={CHART_HEIGHT - 6} textAnchor="middle" className="fill-ink-3 text-10">
            {label.length > 8 ? `${label.slice(0, 7)}…` : label}
          </text>
        ) : null,
      )}
    </>
  );
}

function Frame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <figure data-slot="genui-chart" className="my-1 rounded-card border border-line bg-surface p-3">
      {title && <figcaption className="mb-1 text-12 font-medium text-ink-2">{title}</figcaption>}
      <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="block h-auto w-full max-w-md" role="img" aria-label={title ?? "chart"}>
        {children}
      </svg>
    </figure>
  );
}

export function BarChart({ labels, values, title }: GenuiProps<"BarChart">) {
  const { slot, y, zero } = chartGeometry(values);
  return (
    <Frame title={title}>
      {values.map((value, index) => {
        const top = Math.min(y(value), zero);
        return (
          <rect
            key={index}
            x={CHART_PAD.left + slot * index + slot * 0.15}
            y={top}
            width={slot * 0.7}
            height={Math.max(1, Math.abs(zero - y(value)))}
            rx={2}
            className="fill-accent"
          >
            <title>{`${labels[index] ?? ""}: ${value}`}</title>
          </rect>
        );
      })}
      <Labels labels={labels.slice(0, values.length)} slot={slot} />
    </Frame>
  );
}

export function LineChart({ labels, values, title }: GenuiProps<"LineChart">) {
  const { slot, y } = chartGeometry(values);
  const points = values.map((value, index) => `${CHART_PAD.left + slot * index + slot / 2},${y(value)}`).join(" ");
  return (
    <Frame title={title}>
      <polyline points={points} fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-accent" />
      {values.map((value, index) => (
        <circle key={index} cx={CHART_PAD.left + slot * index + slot / 2} cy={y(value)} r={2.5} className="fill-accent">
          <title>{`${labels[index] ?? ""}: ${value}`}</title>
        </circle>
      ))}
      <Labels labels={labels.slice(0, values.length)} slot={slot} />
    </Frame>
  );
}
