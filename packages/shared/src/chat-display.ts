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

// Settings › Chat: how the sidebar lists Chats. Each device keeps its own choice.

/** One list shows every Chat of every Project in a single list; Grouped by Project keeps a fold per Project. */
export type ChatList = "list" | "grouped";

export const CHAT_LIST_MODES: { id: ChatList; label: string; description: string }[] = [
  { id: "list", label: "One list", description: "Every Chat of every Project in one list, with its Project on the second line." },
  { id: "grouped", label: "Grouped by Project", description: "A group per Project that folds." },
];

export const CHAT_LIST_TITLE = "Chat list";
export const CHAT_LIST_HINT = "How the sidebar lists your Chats.";

/** The label of a Chat list value. */
export function chatListLabel(value: ChatList): string {
  return CHAT_LIST_MODES.find((mode) => mode.id === value)?.label ?? "One list";
}

/** A saved choice; anything else is One list. */
export function parseChatList(value: unknown): ChatList {
  return value === "grouped" ? "grouped" : "list";
}
