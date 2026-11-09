import type { DiffFileEntry } from "../../electron";

// Added and deleted carry their colour (the -ink shades clear 4.8:1 on their tints); modified, the usual case, and
// renamed stay neutral so the list isn't a wall of colour.
const STATUS = {
  added: { letter: "A", label: "Added", className: "bg-green-tint text-green-ink" },
  deleted: { letter: "D", label: "Deleted", className: "bg-red-tint text-red-ink" },
  modified: { letter: "M", label: "Modified", className: "bg-field text-ink-2" },
  renamed: { letter: "R", label: "Renamed", className: "bg-field text-ink-2" },
} as const;

/**
 * +N −M in the diff's -ink colours. A zero side is left out ("+7", not "+7 −0"); with nothing either way both show.
 * `columns` sets each side in its own fixed, right-aligned cell, blank when zero, so a list's numbers line up.
 */
export function Counts({
  added,
  removed,
  className = "",
  total = false,
  columns = false,
}: {
  added: number;
  removed: number;
  className?: string;
  total?: boolean;
  columns?: boolean;
}) {
  if (columns)
    return (
      <span data-diff-counts={total ? "total" : ""} className={`flex shrink-0 items-center font-mono text-11 tabular-nums ${className}`}>
        <span className="min-w-[4ch] text-right text-diff-add">{added > 0 ? `+${added}` : ""}</span>
        <span className="min-w-[4ch] text-right text-diff-remove">{removed > 0 ? `−${removed}` : ""}</span>
      </span>
    );
  const none = !added && !removed;
  return (
    <span data-diff-counts={total ? "total" : ""} className={`flex shrink-0 items-center gap-1.5 font-mono text-11 tabular-nums ${className}`}>
      {(added > 0 || none) && <span className="text-diff-add">+{added}</span>}
      {(removed > 0 || none) && <span className="text-diff-remove">−{removed}</span>}
    </span>
  );
}

/** The 16px cell a StatusBox sits in; a folder row leaves it empty so the count columns line up with the files'. */
export const STATUS_CELL = "size-4 shrink-0";

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
