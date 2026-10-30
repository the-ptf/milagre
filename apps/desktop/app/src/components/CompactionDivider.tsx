import { ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { compactionLabel, compactionText } from "@milagre/shared/compaction";
import type { CompactionContext } from "../model";
import { SpinnerRing } from "./primitives/SpinnerRing";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/**
 * A manual or automatic compaction: a hairline with "Context compacted  897k → 42k" centred on
 * it, as the handoff divider is drawn. It spins while the agent compacts.
 */
export function CompactionDivider({ context }: { context: CompactionContext }) {
  const label = compactionLabel(context);
  return (
    <TranscriptDivider
      data-compaction-divider
      data-status={context.status}
      icon={ArrowShrink01Icon}
      leading={context.status === "preparing" ? <SpinnerRing size={12} /> : undefined}
      label={compactionText(context)}
    >
      <span className={context.status === "failed" ? "text-orange-ink" : ""}>{label.title}</span>
      {label.before && (
        <span className="font-mono text-11 tabular-nums">
          <span className={label.after ? "" : "font-medium text-ink-2"}>{label.before}</span>
          {label.after && (
            <>
              <span aria-hidden="true"> → </span>
              <span className="font-medium text-ink-2">{label.after}</span>
            </>
          )}
        </span>
      )}
    </TranscriptDivider>
  );
}
