// Settings › Chat: how much of a reply's work the Chat shows. Each device keeps its own choice.

/** Compact folds a reply's tool calls into one line; Full detail shows each one, with the notes between them. */
export type ToolCallDisplay = "compact" | "full";

export const TOOL_CALL_DISPLAYS: { id: ToolCallDisplay; label: string; description: string }[] = [
  { id: "compact", label: "Compact", description: "One line per reply." },
  { id: "full", label: "Full detail", description: "Each call on its own row." },
];

export const DETAIL_LEVEL_TITLE = "Detail level";
export const EXPAND_REASONING_TITLE = "Always expand reasoning";
export const EXPAND_REASONING_HINT = "Show the agent's thinking open, instead of folded into its row.";
export const TOOL_CALL_DISPLAY_TITLE = "Tool call display";
export const TOOL_CALL_DISPLAY_HINT = "How tool calls appear in the Chat.";

/** A saved choice; `murilo` is the Experimental switch it replaces, which meant Full detail when on. */
export function parseToolCallDisplay(value: unknown, murilo?: unknown): ToolCallDisplay {
  if (value === "compact" || value === "full") return value;
  return murilo === true ? "full" : "compact";
}
