// A subagent's calls would draft the same way, with `agent`: the id of the Agent call that started it. Claude Code
// (checked through 2.1.329) writes `parent_tool_use_id: null` on every stream_event and streams no subagent input, so
// subagent designs reach the canvas only as replays of the saved version.

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

function claudeDesignDrafts(event, state, agent = null) {
  const key = (index) => (agent ? `${agent}:${index}` : index);
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
