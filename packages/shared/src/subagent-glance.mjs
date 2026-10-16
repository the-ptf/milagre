// What a subagent is doing, at a glance (the Subagents panel on desktop and phone). A subagent's transcript is its own
// words (message entries) between tool calls (tool entries): each message starts a step, and the tool calls after it are
// counted by category, so the panel shows "Now checking the Notion sheet" and "8 images · 2 commands" instead of the log.
// The host keeps the running totals (`progress`), since a client holds only the tail of a running subagent's transcript.

/** @typedef {import("./model.ts").StepKind} StepKind */
/** @typedef {"commands" | "images" | "reads" | "searches" | "edits" | "other"} ToolCategory */

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)\b/i;
// Ties go to the calls that change more: edits, then commands.
const ORDER = ["edits", "commands", "images", "reads", "searches", "other"];
const LABELS = {
  commands: ["command", "commands"],
  images: ["image", "images"],
  reads: ["file read", "files read"],
  searches: ["search", "searches"],
  edits: ["edit", "edits"],
  other: ["other tool", "other tools"],
};

// A transcript entry the provider left without its step kind (one saved before the kind was kept): from its title.
function kindOfTitle(text) {
  const title = String(text ?? "");
  if (title.startsWith("Ran ")) return "shell";
  if (/^(Read|Viewed) /.test(title)) return IMAGE_FILE.test(title.split("\n")[0]) ? "image" : "read";
  if (/^(Edited|Wrote|Created|Deleted) /.test(title)) return "edit";
  if (/^(Searched|Found files|Listed files)/.test(title)) return "search";
  return "other";
}

/** The category a tool call counts under; a read of an image file is an image. */
export function toolCategory(kind, text) {
  const resolved = kind ?? kindOfTitle(text);
  if (resolved === "shell") return "commands";
  if (resolved === "image") return "images";
  if (resolved === "read") return IMAGE_FILE.test(String(text ?? "").split("\n")[0]) ? "images" : "reads";
  if (resolved === "search") return "searches";
  if (resolved === "edit") return "edits";
  return "other";
}

/** "8 images · 2 commands": the categories with the most calls first, at most `limit` of them. */
export function toolSummary(counts, limit = 3) {
  return ORDER.filter((category) => counts?.[category] > 0)
    .sort((a, b) => counts[b] - counts[a] || ORDER.indexOf(a) - ORDER.indexOf(b))
    .slice(0, limit)
    .map((category) => `${counts[category]} ${LABELS[category][counts[category] === 1 ? 0 : 1]}`)
    .join(" · ");
}

/** The counts per category as a list, for chips: [{ category, count, label }]. */
export function toolChips(counts) {
  return ORDER.filter((category) => counts?.[category] > 0).map((category) => ({
    category,
    count: counts[category],
    label: `${counts[category]} ${LABELS[category][counts[category] === 1 ? 0 : 1]}`,
  }));
}

/** A tool call's title as plain text, for a line that can't draw code: "Read `a.ts`" reads "Read a.ts". */
export const plainTitle = (text) => String(text ?? "").replace(/`/g, "");

/** The first sentence of what an agent said, without Markdown marks; the whole first line when it has no sentence end. */
export function firstSentence(text) {
  const line =
    String(text ?? "")
      .split("\n")
      .map((part) => part.replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, "").trim())
      .find(Boolean) ?? "";
  const plain = line.replace(/\*\*|__|`/g, "");
  const end = /[.!?](\s|$)/.exec(plain);
  return (end ? plain.slice(0, end.index + 1) : plain).trim();
}

// The final answer and the provider's own summary are the outcome, not a step.
const isOutcome = (entry) => entry.id === "result" || entry.id === "summary";
// Claude's tool results ride in the transcript as tool entries of their own; they aren't calls.
const isToolResult = (entry) => entry.id.startsWith("result:");

/** Whether `entry` starts a step: something the agent said. */
export const isStep = (entry) => entry.kind === "message" && !isOutcome(entry) && Boolean(entry.text?.trim());
/** Whether `entry` is a tool call that counts. */
export const isToolCall = (entry) => entry.kind === "tool" && !isToolResult(entry);

/** `progress` with `entry` added: the host calls this once for each new transcript entry. */
export function addProgress(progress, entry) {
  const current = progress ?? { steps: 0, tools: {} };
  if (isToolCall(entry)) {
    const category = toolCategory(entry.tool, entry.text);
    return { ...current, tools: { ...current.tools, [category]: (current.tools[category] ?? 0) + 1 } };
  }
  if (isStep(entry)) return { ...current, steps: current.steps + 1, said: firstSentence(entry.text) };
  return current;
}

/**
 * The steps of a whole transcript, oldest first: what the agent said and the tool calls that followed, counted. Calls
 * before the agent said anything make a first step without words.
 */
export function subagentSteps(transcript) {
  const steps = [];
  for (const entry of transcript ?? []) {
    if (isStep(entry)) steps.push({ id: entry.id, said: firstSentence(entry.text), text: entry.text, tools: {} });
    else if (isToolCall(entry)) {
      if (!steps.length) steps.push({ id: `start:${entry.id}`, said: "", text: "", tools: {} });
      const step = steps.at(-1);
      const category = toolCategory(entry.tool, entry.text);
      step.tools[category] = (step.tools[category] ?? 0) + 1;
      step.lastTool = entry.text.split("\n")[0];
    }
  }
  return steps;
}

/** The last thing a subagent said in `steps`; undefined before it said anything. */
export function lastSaid(steps) {
  for (let index = steps.length - 1; index >= 0; index--) if (steps[index].said) return steps[index].said;
  return undefined;
}

/** The subagent's final answer or summary, first sentence; undefined while it has none. */
export function subagentOutcome(transcript) {
  const entry = [...(transcript ?? [])].reverse().find((item) => item.kind === "message" && isOutcome(item) && item.text?.trim());
  return entry ? firstSentence(entry.text) : undefined;
}

/** Done and total of a subagent's own to-do list; null when it keeps none. */
export function planCounts(tasks) {
  if (!tasks?.length) return null;
  return { done: tasks.filter((task) => task.status === "completed").length, total: tasks.length };
}
