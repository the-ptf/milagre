import { piStatsParts } from "@milagre/shared/pi-models";
import type { ContextUsage } from "../../model";

/** One quiet line under a Pi Chat's composer: a local model's last turn, and what the Chat has spent on paid models. */
export function PiStats({ usage, local }: { usage: ContextUsage | undefined; local: boolean }) {
  const parts = piStatsParts(usage, { local });
  if (!parts.length) return null;
  return (
    <div
      data-pi-stats
      aria-label={local ? "Last turn on this computer" : "This Chat on Pi"}
      className="mt-1 flex flex-wrap justify-center gap-x-2 px-3 text-11 text-ink-3 tabular-nums opacity-20 transition-opacity duration-fast hover:opacity-100"
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
