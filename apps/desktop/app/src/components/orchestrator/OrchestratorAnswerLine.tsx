import { useOrchestrator } from "../../lib/orchestrator-store";
import { Mascot } from "./Mascot";

/** One line in a task Chat for something autopilot answered: the Pebble, then what it chose, commands in code. */
export function OrchestratorAnswerLine({ summary }: { summary: string }) {
  const color = useOrchestrator().settings.mascotColor;
  return (
    <div
      data-orchestrator-answer
      role="note"
      aria-label={`The Orchestrator answered for you: ${summary}`}
      className="flex min-w-0 items-center gap-2 py-0.5 text-12 text-ink-2"
    >
      <Mascot size={16} color={color} mood="happy" still />
      <span className="min-w-0 truncate">
        {summary.split("`").map((part, index) =>
          index % 2 ? (
            <code key={index} className="rounded-inline bg-field px-1 font-mono text-11 text-ink">
              {part}
            </code>
          ) : (
            part
          ),
        )}
      </span>
    </div>
  );
}
