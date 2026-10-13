import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, EyeIcon, Flag01Icon, GitMergeIcon, Rocket01Icon, Target02Icon, TestTube01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { PHASES } from "@milagre/shared/chat-plan";
import { phaseGraph, phaseGraphPath, rowY } from "@milagre/shared/phase-graph";
import type { ChatPhase, ChatPlan } from "../../model";

export const PHASE_LABELS: Record<ChatPhase, string> = {
  start: "Start",
  plan: "Plan",
  build: "Build",
  test: "Test",
  review: "Review",
  merge: "Merge",
  release: "Release",
  done: "Done",
};
const PHASE_ICONS = {
  start: Flag01Icon,
  plan: Target02Icon,
  build: Wrench01Icon,
  test: TestTube01Icon,
  review: EyeIcon,
  merge: GitMergeIcon,
  release: Rocket01Icon,
  done: CheckmarkCircle02Icon,
} as const;

const HEIGHT = 168;
// One legend row per phase: its centre is rowY(row, HEIGHT), so every dot sits on its label.
const ROW = HEIGHT / PHASES.length;
const FALLBACK_WIDTH = 260;

/** The Chat's phase history on a time axis that ends at Now; long idle stretches fold into a labelled gap. */
export function PhaseGraph({ plan, now: fixedNow }: { plan: ChatPlan; now?: number }) {
  // Now is taken when the graph opens, so rerenders do not move the axis.
  const [opened] = useState(() => fixedNow ?? Date.now());
  // The SVG is drawn in real pixels at the cell's width, so its rows line up with the legend beside it.
  const [cell, setCell] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    if (!cell) return;
    const measure = () => setWidth(Math.max(1, Math.round(cell.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [cell]);
  const graph = phaseGraph(plan.phases, opened);
  if (!graph.points.length || !graph.current) return null;
  const path = phaseGraphPath(graph.points, width, HEIGHT);
  const last = graph.points.length - 1;
  return (
    <section data-slot="phase-graph" aria-label="Phase graph" className="flex shrink-0 flex-col gap-2 px-2 pb-2">
      <h3 className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
        <span aria-hidden className="h-px w-3 bg-accent" />
        Phase graph
      </h3>
      <div className="flex gap-2">
        <ol className="flex shrink-0 flex-col-reverse" style={{ height: HEIGHT }}>
          {PHASES.map((phase) => {
            const current = graph.current === phase;
            return (
              <li
                key={phase}
                {...(current ? { "data-current-phase": "" } : {})}
                style={{ height: ROW }}
                className={`flex items-center gap-1 rounded px-1 text-[11px] leading-none ${current ? "bg-hover text-ink" : "text-ink-3"}`}
              >
                <HugeiconsIcon icon={PHASE_ICONS[phase]} size={11} aria-hidden />
                {PHASE_LABELS[phase]}
              </li>
            );
          })}
        </ol>
        <div ref={setCell} className="relative min-w-0 flex-1">
          <svg width={width} height={HEIGHT + 18} className="block overflow-visible" role="img" aria-label={`Current phase: ${PHASE_LABELS[graph.current]}`}>
            <path d={path} fill="none" strokeWidth={2} className="stroke-accent" strokeLinecap="round" />
            {graph.points.map((point, index) => (
              <circle
                key={`${point.at}-${point.phase}`}
                cx={point.x * width}
                cy={rowY(point.row, HEIGHT)}
                r={index === last ? 5 : 3}
                className={index === last ? "fill-accent" : "fill-ink-2"}
              />
            ))}
            {graph.gaps.map((gap) => (
              <g key={`${gap.x0}-${gap.x1}`} data-gap>
                <rect x={((gap.x0 + gap.x1) / 2) * width - 12} y={HEIGHT / 2 - 8} width={24} height={16} rx={4} className="fill-hover" />
                <text x={((gap.x0 + gap.x1) / 2) * width} y={HEIGHT / 2 + 4} textAnchor="middle" className="fill-ink-2 text-[10px]">
                  {gap.label}
                </text>
              </g>
            ))}
            <line x1={width} x2={width} y1={0} y2={HEIGHT} strokeDasharray="3 3" className="stroke-accent" />
            {graph.ticks.map((tick) => (
              <text key={tick.x} x={tick.x * width} y={HEIGHT + 14} textAnchor="middle" className="fill-ink-3 text-[10px]">
                {tick.label}
              </text>
            ))}
            <text x={width} y={HEIGHT + 14} textAnchor="middle" className="fill-ink-3 text-[10px]">
              Now
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
}
