import { useMemo, useState } from "react";
import type { ChatStep } from "../../model";
import { stepSections } from "@milagre/shared/tool-activity";
import { parsePatch } from "../../lib/diff-parse";
import { CodeBlock } from "../markdown/CodeBlock";
import { Button } from "../primitives/Button";
import { StepDiff } from "./StepDiff";

/** Output stays lazy and bounded; revealing lines never changes which call the user opened. */
export function StepOutput({ step, detail }: { step: ChatStep; detail?: string }) {
  const [all, setAll] = useState(false);
  const sections = stepSections(step, detail);
  // An edit's unified diff draws like the Changes view; anything that doesn't parse as one stays a code block.
  const hunks = useMemo(() => (step.kind === "edit" && sections.output ? parsePatch(sections.output) : []), [step.kind, sections.output]);
  const lines = sections.output.replace(/\n$/, "").split("\n");
  const clipped = !all && lines.length > 40;
  const consoleOutput = step.kind === "shell" || step.kind === "setup";
  const output = clipped ? (consoleOutput ? lines.slice(-40) : lines.slice(0, 40)).join("\n") : sections.output;
  // An input that is only the file's path repeats the row's own title; it adds nothing.
  const input = sections.input && sections.input !== step.file ? sections.input : "";
  return (
    <div className="min-w-0">
      {input && <CodeBlock code={input} fence={consoleOutput ? "bash" : step.source ? "json" : "text"} label={sections.inputLabel} />}
      {hunks.length > 0 ? (
        <StepDiff hunks={hunks} path={step.file ?? ""} copyText={sections.output} />
      ) : (
        sections.output && (
          <CodeBlock
            code={output}
            copyCode={sections.output}
            fence={step.kind === "edit" ? "diff" : consoleOutput ? "console" : undefined}
            label={`${sections.outputLabel}${clipped ? ` · ${consoleOutput ? "last" : "first"} 40 of ${lines.length} lines` : ""}`}
          />
        )
      )}
      {clipped && hunks.length === 0 && (
        <Button variant="quiet" size={24} onClick={() => setAll(true)} className="mb-2">
          Show {lines.length - 40} {consoleOutput ? "earlier" : "more"} lines
        </Button>
      )}
    </div>
  );
}
