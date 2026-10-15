// Claude streams a tool call's input as pieces of JSON (input_json_delta) while the model writes it. For Milagre's
// design tools those pieces go to the windows as step-draft events, so the Designs canvas can build the design as the
// agent writes it, before the call runs. Other tools' inputs are never sent.
//
// A draft is { type: "step-draft", id, tool, offset, text, done? }: `id` is the tool_use id, the same as the step the
// call becomes; `text` continues the input at `offset` (the first event, at the block's start, is empty at 0); `done`
// marks the input whole. Pieces go out at most every DRAFT_MS, and at the block's end.
//
// A subagent's calls draft the same way, with `agent`: the id of the Agent call that started it. Claude Code 2.1.299
// sends no stream events for subagents (only their whole messages), so today only the parent's calls draft; a
// subagent's design calls still reach the canvas as steps (events.cjs), which play back when saved.

const DRAFT_TOOLS = /^mcp__milagre__(design_show|design_apply)$/;
const DRAFT_MS = 120;

const now = (state) => (state.now ?? Date.now)();

function flush(state, draft, done = false) {
  if (!draft.pending && !done) return [];
  const event = {
    type: "step-draft",
    id: draft.id,
    tool: draft.tool,
    offset: draft.sent,
    text: draft.pending,
    ...(done ? { done: true } : {}),
    ...(draft.agent ? { agent: draft.agent } : {}),
  };
  draft.sent += draft.pending.length;
  draft.pending = "";
  draft.at = now(state);
  return [event];
}

/** step-draft events for one stream event of the parent agent, or of the subagent `agent` names. */
function claudeDesignDrafts(event, state, agent = null) {
  // Block indexes count per agent's message.
  const key = (index) => (agent ? `${agent}:${index}` : index);
  // A new message starts its block indexes again; a block a cancelled stream never stopped is dropped.
  if (event.type === "message_start") {
    for (const [at, draft] of state.drafts ?? []) if ((draft.agent ?? null) === agent) state.drafts.delete(at);
    return [];
  }
  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    const tool = DRAFT_TOOLS.exec(String(event.content_block.name ?? ""))?.[1];
    if (!tool || typeof event.content_block.id !== "string" || !event.content_block.id) return [];
    state.drafts ??= new Map();
    const draft = { id: event.content_block.id, tool, sent: 0, pending: "", at: now(state), ...(agent ? { agent } : {}) };
    state.drafts.set(key(event.index), draft);
    return [{ type: "step-draft", id: draft.id, tool, offset: 0, text: "", ...(agent ? { agent } : {}) }];
  }
  const draft = state.drafts?.get(key(event.index));
  if (!draft) return [];
  if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") {
    draft.pending += event.delta.partial_json;
    return now(state) - draft.at >= DRAFT_MS ? flush(state, draft) : [];
  }
  if (event.type === "content_block_stop") {
    state.drafts.delete(key(event.index));
    return flush(state, draft, true);
  }
  return [];
}

module.exports = { DRAFT_MS, claudeDesignDrafts };
