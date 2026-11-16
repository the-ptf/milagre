import { useReducedMotion } from "motion/react";

export function AgentCursor({
  x,
  y,
  scale,
  color,
  ink = "#fff",
  label,
  task,
  note,
}: {
  x: number;
  y: number;
  scale: number;
  color: string;
  ink?: string;
  label: string;
  task?: string;
  note?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <div
      aria-hidden
      data-slot="agent-cursor"
      data-agent={label}
      data-x={Math.round(x)}
      data-y={Math.round(y)}
      className="pointer-events-none absolute top-0 left-0 z-20"
      style={{
        transform: `translate(${x}px, ${y}px)`,
        transition: reduced ? undefined : "transform var(--duration-base) var(--ease-enter)",
      }}
    >
      <div className="origin-top-left" style={{ transform: `scale(${1 / scale})` }}>
        <svg width="18" height="20" viewBox="0 0 18 20" className="block drop-shadow-[0_1px_2px_rgba(0,0,0,.35)]">
          <path d="M1.5 1.5 L16 10.2 L9.4 11.6 L6 18 Z" fill={color} stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <span
          data-slot="agent-cursor-label"
          // The label takes the pointer only to show a subagent's task.
          title={task}
          className={`absolute top-[17px] left-3 flex items-center gap-1 whitespace-nowrap rounded-chip rounded-tl-inline px-1.5 py-0.5 text-11 font-medium shadow-raised ${task ? "pointer-events-auto" : ""}`}
          style={{ background: color, color: ink }}
        >
          {label}
          {note && <span className="font-normal opacity-80">{note}</span>}
        </span>
      </div>
    </div>
  );
}
