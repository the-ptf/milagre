import type { DiffFileEntry } from "../../electron";

const STATUS = {
  added: { letter: "A", label: "Added", className: "bg-green-tint text-diff-add" },
  deleted: { letter: "D", label: "Deleted", className: "bg-red-tint text-diff-remove" },
  modified: { letter: "M", label: "Modified", className: "bg-orange-tint text-orange-ink" },
  renamed: { letter: "R", label: "Renamed", className: "bg-accent-tint text-accent-ink" },
} as const;

export function Counts({ added, removed, className = "", total = false }: { added: number; removed: number; className?: string; total?: boolean }) {
  return (
    <span data-diff-counts={total ? "total" : ""} className={`flex shrink-0 items-center gap-1.5 font-mono text-11 tabular-nums ${className}`}>
      <span className="text-diff-add">+{added}</span>
      <span className="text-diff-remove">−{removed}</span>
    </span>
  );
}

export function StatusBox({ status }: { status: DiffFileEntry["status"] }) {
  const { letter, label, className } = STATUS[status];
  return (
    <span
      aria-label={label}
      data-status={letter}
      className={`flex size-4 shrink-0 items-center justify-center rounded-inline font-mono text-10 font-semibold ${className}`}
    >
      {letter}
    </span>
  );
}
