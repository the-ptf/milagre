import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { compactionLabel, compactionText } from "@milagre/shared/compaction";
import type { CompactionContext } from "../model";
import { SpinnerRing } from "./primitives/SpinnerRing";

/**
 * A manual or automatic compaction: a hairline with "Context compacted  897k → 42k" centred on
 * it, as the handoff divider is drawn. It spins while the agent compacts.
 */
export function CompactionDivider({ context }: { context: CompactionContext }) {
  const label = compactionLabel(context);
  if (context.quiet && context.status !== "failed") return null;
  return (
    <div
      data-compaction-divider
      data-status={context.status}
      className="flex w-full items-center gap-3 py-1 text-[12px] text-ink-3"
      role="group"
      aria-label={compactionText(context)}
    >
      <span className="h-px flex-1 bg-line" />
      <span className="flex items-center gap-1.5 px-2 py-0.5">
        {context.status === "preparing" ? (
          <SpinnerRing size={12} />
        ) : (
          <HugeiconsIcon icon={ArrowShrink01Icon} size={13} strokeWidth={1.8} color="currentColor" />
        )}
        <span className={context.status === "failed" ? "text-orange-ink" : ""}>{label.title}</span>
        {label.before && (
          <span className="font-mono text-[11.5px] tabular-nums">
            <span className={label.after ? "" : "font-medium text-ink-2"}>{label.before}</span>
            {label.after && (
              <>
                <span aria-hidden="true"> → </span>
                <span className="font-medium text-ink-2">{label.after}</span>
              </>
            )}
          </span>
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
