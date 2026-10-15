// Claude streams a tool call's input as pieces of JSON (input_json_delta) while the model writes it. For Milagre's
// design tools those pieces go to the windows as step-draft events, so the Designs canvas can build the design as the
// agent writes it, before the call runs. Other tools' inputs are never sent.
//
// A draft is { type: "step-draft", id, tool, offset, text, done? }: `id` is the tool_use id, the same as the step the
// call becomes; `text` continues the input at `offset` (the first event, at the block's start, is empty at 0); `done`
// marks the input whole. Pieces go out at most every DRAFT_MS, and at the block's end.

const DRAFT_TOOLS = /^mcp__milagre__(design_show|design_apply)$/;
const DRAFT_MS = 120;

const now = (state) => (state.now ?? Date.now)();

function flush(state, draft, done = false) {
  if (!draft.pending && !done) return [];
  const event = { type: "step-draft", id: draft.id, tool: draft.tool, offset: draft.sent, text: draft.pending, ...(done ? { done: true } : {}) };
  draft.sent += draft.pending.length;
  draft.pending = "";
  draft.at = now(state);
  return [event];
}

/** step-draft events for one of the parent agent's stream events (a subagent's calls are not drafted). */
function claudeDesignDrafts(event, state) {
  // A new message starts its block indexes again; a block a cancelled stream never stopped is dropped.
  if (event.type === "message_start") {
    state.drafts?.clear();
    return [];
  }
  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    const tool = DRAFT_TOOLS.exec(String(event.content_block.name ?? ""))?.[1];
    if (!tool || typeof event.content_block.id !== "string" || !event.content_block.id) return [];
    state.drafts ??= new Map();
    const draft = { id: event.content_block.id, tool, sent: 0, pending: "", at: now(state) };
    state.drafts.set(event.index, draft);
    return [{ type: "step-draft", id: draft.id, tool, offset: 0, text: "" }];
  }
  const draft = state.drafts?.get(event.index);
  if (!draft) return [];
  if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
    draft.pending += event.delta.partial_json;
    return now(state) - draft.at >= DRAFT_MS ? flush(state, draft) : [];
  }
  if (event.type === "content_block_stop") {
    state.drafts.delete(event.index);
    return flush(state, draft, true);
  }
  return [];
}

module.exports = { DRAFT_MS, claudeDesignDrafts };
