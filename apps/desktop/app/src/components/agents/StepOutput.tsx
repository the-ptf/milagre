import { useState } from "react";
import type { ChatStep } from "../../model";
import { stepSections } from "@milagre/shared/tool-activity";
import { CodeBlock } from "../markdown/CodeBlock";

/** Output stays lazy and bounded; revealing lines never changes which call the user opened. */
export function StepOutput({ step, detail }: { step: ChatStep; detail?: string }) {
  const [all, setAll] = useState(false);
  const sections = stepSections(step, detail);
  const lines = sections.output.replace(/\n$/, "").split("\n");
  const clipped = !all && lines.length > 40;
  const consoleOutput = step.kind === "shell" || step.kind === "setup";
  const output = clipped ? (consoleOutput ? lines.slice(-40) : lines.slice(0, 40)).join("\n") : sections.output;
  return (
    <div className="min-w-0">
      {sections.input && <CodeBlock code={sections.input} fence={consoleOutput ? "bash" : step.source ? "json" : "text"} label={sections.inputLabel} />}
      {sections.output && (
        <CodeBlock
          code={output}
          copyCode={sections.output}
          fence={step.kind === "edit" ? "diff" : consoleOutput ? "console" : undefined}
          label={`${sections.outputLabel}${clipped ? ` · ${consoleOutput ? "last" : "first"} 40 of ${lines.length} lines` : ""}`}
        />
      )}
      {clipped && (
        <button type="button" onClick={() => setAll(true)} className="mb-2 rounded-control px-2 py-1 text-[12px] text-ink-2 hover:bg-hover hover:text-ink">
          Show {lines.length - 40} {consoleOutput ? "earlier" : "more"} lines
        </button>
      )}
    </div>
  );
}
