// An escalation-only turn: the agent above a waiting Subchat was woken to tell the human about it (subchat-escalation.cjs
// in agents), so it may read and answer the requests it was woken for, and nothing else, whatever its permission mode.
// The babysit path (babysit-guard.cjs) refuses shell commands; this refuses every tool, Milagre's own included, at each
// provider's own gate and again where Milagre's tools run (chatTools in runtime.cjs).
const { ESCALATION_TOOL_CALLS, ESCALATION_TOOL_GRACE } = require("@milagre/shared/subchat-escalation");

const ESCALATION_LEVEL = "escalation";
const RESPOND_TOOL = "chat_respond";
const ONLY_READS =
  "This turn only tells the human about a waiting Subchat: you can read, and use chat_respond on the requests you were woken for. Everything else waits for the human's next message.";
const REPLY_NOW = "You have used this turn's tool calls: reply to the human now, with what you know and your recommendation.";

// The providers whose every tool passes a gate Milagre holds, in every mode. One that can't refuse a tool gets no wake.
const GUARDED_PROVIDERS = new Set(["claude", "codex", "antigravity", "kiro"]);
const canEscalate = (provider) => GUARDED_PROVIDERS.has(provider);

// Claude Code's own reads. Bash isn't one: a command can do anything.
const CLAUDE_READS = new Set(["Read", "Grep", "Glob", "LS", "ToolSearch"]);
// ACP's tool kinds that change nothing. `fetch` reaches the network, so it stays out.
const ACP_READS = new Set(["read", "search"]);

const isMilagreRead = (tools, name) => Boolean(tools?.some((tool) => tool.name === name && tool.readOnly === true));

/** A Claude tool call, from its hook or canUseTool. */
function claudeCall(toolName, input, tools) {
  const milagre = /^mcp__milagre__(.+)$/.exec(toolName ?? "")?.[1];
  return { name: milagre ?? toolName, input, readOnly: milagre ? isMilagreRead(tools, milagre) : CLAUDE_READS.has(toolName) };
}

/** A Codex MCP approval: Codex names the tool only in its message. Another server's tool can't be known to be a read. */
function codexMcpCall(params, tools) {
  const name = /run tool "([^"]+)"/.exec(String(params.message ?? ""))?.[1];
  if (params.serverName !== "milagre" || !name) return { name: "" };
  const { _meta: meta } = params;
  return { name, input: meta?.tool_params, readOnly: isMilagreRead(tools, name) };
}

/** An ACP permission request; `call` is the tool call as far as it is known. An MCP tool's arguments sit one level down. */
function acpCall(call, tools) {
  const { _meta: meta } = call;
  const mcp = meta?.mcp;
  if (mcp?.server === "milagre") return { name: mcp.tool, input: call.rawInput?.arguments ?? call.rawInput, readOnly: isMilagreRead(tools, mcp.tool) };
  return { name: String(call.title ?? ""), input: call.rawInput, readOnly: !mcp && ACP_READS.has(call.kind) };
}

/** What one wake's turn may still do. `guard.requests` are the requests it was woken for; `stop()` ends the turn. */
class EscalationTurn {
  constructor(guard, stop) {
    Object.assign(this, { guard, stop, calls: 0 });
  }

  /** One more tool call, allowed or not. One past the grace stops the turn: the agent was told to reply and didn't. */
  called() {
    this.calls += 1;
    if (this.calls === ESCALATION_TOOL_CALLS + ESCALATION_TOOL_GRACE + 1) this.stop();
  }

  /** Why this call is refused, or null when it may run. */
  denial({ name, input, readOnly = false }) {
    if (this.calls > ESCALATION_TOOL_CALLS) return REPLY_NOW;
    if (readOnly) return null;
    const batched = this.guard.requests.some((request) => request.chatId === input?.chatId && request.requestId === input?.requestId);
    return name === RESPOND_TOOL && batched ? null : ONLY_READS;
  }
}

/** A turn's guards: `escalation` for a wake's, else the babysit `guard` the session enforces on each command. */
function turnGuards(guard, stop) {
  return guard?.level === ESCALATION_LEVEL ? { guard: null, escalation: new EscalationTurn(guard, stop) } : { guard: guard ?? null, escalation: null };
}

module.exports = { ESCALATION_LEVEL, EscalationTurn, ONLY_READS, acpCall, canEscalate, claudeCall, codexMcpCall, turnGuards };
