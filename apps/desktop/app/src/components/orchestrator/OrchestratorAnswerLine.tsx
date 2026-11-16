import { useState } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useOrchestrator } from "../../lib/orchestrator-store";
import { Icon } from "../primitives/Icon";
import { Mascot } from "./Mascot";

function Summary({ text }: { text: string }) {
  return (
    <span className="min-w-0 truncate">
      {text.split("`").map((part, index) =>
        index % 2 ? (
          <code key={index} className="rounded-inline bg-field px-1 font-mono text-11 text-ink">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** What autopilot answered in a task Chat, after the Pebble: one line, or a count that opens the list when it answered several in a row. */
export function OrchestratorAnswerLine({ summaries }: { summaries: readonly string[] }) {
  const { mascotColor: color, name } = useOrchestrator().settings;
  const [open, setOpen] = useState(false);
  const pebble = <Mascot size={16} color={color} mood="happy" still />;
  if (summaries.length < 2)
    return (
      <div data-orchestrator-answer role="note" className="flex min-w-0 items-center gap-2 py-0.5 text-12 text-ink-2">
        {pebble}
        <span className="shrink-0 font-medium text-ink">{name}</span>
        <Summary text={summaries[0] ?? ""} />
      </div>
    );
  return (
    <div data-orchestrator-answer role="note" className="flex min-w-0 flex-col gap-1 py-0.5 text-12 text-ink-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 self-start rounded-control text-left hover:text-ink"
      >
        {pebble}
        <span className="font-medium text-ink">{name}</span> answered {summaries.length} for you
        <Icon icon={ArrowDown01Icon} size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="flex flex-col gap-1 border-l border-line pl-3 ml-2">
          {summaries.map((summary, index) => (
            <li key={index} className="flex min-w-0">
              <Summary text={summary} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
