import { turnMetricsParts } from "@milagre/shared/ollama-models";
import type { TurnMetrics } from "../../model";

/** The last turn's speed on a local model, in one quiet line under the composer. */
export function LocalModelStats({ metrics }: { metrics: TurnMetrics | undefined }) {
  const parts = turnMetricsParts(metrics);
  if (!parts.length) return null;
  return (
    <div
      data-local-model-stats
      aria-label="Last turn on this computer"
      className="mt-1 flex flex-wrap justify-center gap-x-2 px-3 text-11 text-ink-3 tabular-nums opacity-50 transition-opacity duration-fast hover:opacity-100"
    >
      {parts.map((part, index) => (
        <span key={part.key} title={part.label}>
          {index > 0 && <span className="mr-2 text-ink-4">·</span>}
          {part.text}
        </span>
      ))}
    </div>
  );
}
