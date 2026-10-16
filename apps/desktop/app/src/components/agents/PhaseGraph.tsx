import { useEffect, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, EyeIcon, Flag01Icon, GitMergeIcon, Rocket01Icon, Target02Icon, TestTube01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { PHASES } from "@milagre/shared/chat-plan";
import { phaseGraph, phaseGraphLayout } from "@milagre/shared/phase-graph";
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
export function PhaseGraph({ plan, now: fixedNow, action }: { plan: ChatPlan; now?: number; action?: ReactNode }) {
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
  const layout = phaseGraphLayout(graph, width, { height: HEIGHT });
  return (
    <section data-slot="phase-graph" aria-label="Phase graph" className="flex shrink-0 flex-col gap-2 px-2 pb-2">
      <div className="flex items-center">
        <h3 className="flex-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">Phase graph</h3>
        {action}
      </div>
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
          <svg width={width} height={HEIGHT + 18} className="block" role="img" aria-label={`Current phase: ${PHASE_LABELS[graph.current]}`}>
            <path d={layout.path} fill="none" strokeWidth={2} className="stroke-accent" strokeLinecap="round" />
            <line x1={layout.now.lineX} x2={layout.now.lineX} y1={0} y2={HEIGHT} strokeDasharray="3 3" className="stroke-accent" />
            {layout.points.map((point) => (
              <circle
                key={`${point.at}-${point.phase}`}
                cx={point.x}
                cy={point.y}
                r={point.current ? 5 : 3}
                className={point.current ? "fill-accent" : "fill-ink-2"}
              />
            ))}
            {layout.gaps.map((gap) => (
              <g key={`${gap.x}-${gap.label}`} data-gap>
                <rect x={gap.x - 12} y={gap.y - 8} width={24} height={16} rx={4} className="fill-hover" />
                <text x={gap.x} y={gap.y + 4} textAnchor="middle" className="fill-ink-2 text-[10px]">
                  {gap.label}
                </text>
              </g>
            ))}
            {layout.ticks.map((tick) => (
              <text key={tick.x} x={tick.x} y={HEIGHT + 14} textAnchor={tick.anchor} className="fill-ink-3 text-[10px]">
                {tick.label}
              </text>
            ))}
            <text x={layout.now.x} y={HEIGHT + 14} textAnchor={layout.now.anchor} className="fill-ink-3 text-[10px]">
              Now
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
}
