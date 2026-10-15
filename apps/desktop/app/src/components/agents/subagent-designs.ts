import type { ChatStep } from "../../model";

/** What a subagent is designing now, or designed last: the design's title, and its id once saved. */
export type SubagentDesign = { title: string | null; id: string | null; designing: boolean };

// "Showed `Card`" names the design; "Edited `a design`" (a design_apply before it is saved) doesn't.
const titleOf = (title: string) => {
  const named = /`([^`]+)`/.exec(title)?.[1];
  return named && named !== "a design" && named !== "an artifact" ? named : null;
};

/**
 * Each subagent's design work among a Chat's steps, by subagent id: its design call running now, or else the last
 * design it saved. Artifact pages (artifact_show) aren't designs.
 */
export function subagentDesigns(steps: readonly ChatStep[]): Map<string, SubagentDesign> {
  const designs = new Map<string, SubagentDesign>();
  for (const step of steps) {
    if (step.kind !== "artifact" || !step.agent || step.tool === "artifact_show" || step.artifact?.format === "html") continue;
    if (step.status === "running") designs.set(step.agent, { title: titleOf(step.title), id: null, designing: true });
    else if (step.status === "done" && step.artifact && !designs.get(step.agent)?.designing)
      designs.set(step.agent, { title: step.artifact.title, id: step.artifact.id, designing: false });
  }
  return designs;
}
