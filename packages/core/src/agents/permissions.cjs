const path = require("node:path");
const { PLAN_TOOL_NAMES } = require("../chat-plan-tools.cjs");

// Approval requests from both agents, in the shape of the `permission-request` event, and the
// replies each agent expects for the user's answer. A request is
//   { requestId, kind: "command"|"edit"|"other", tool, title, description?, command?, cwd?,
//     diff?, files?, detail?, reason?, allowForChat, stepId? }
// where stepId names the tool step (see steps.cjs) the request is about,
// and a decision is "allow" | "allow-for-chat" | "deny", or "cancelled" when the turn stops first.

const DENIED_MESSAGE = "Denied in Milagre";
const CANCELLED_MESSAGE = "The turn was cancelled in Milagre.";
const USER_DECISIONS = new Set(["allow", "allow-for-chat", "deny"]);
const MAX_TEXT = 20_000;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function capText(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… truncated` : text;
}

// Drops undefined fields so requests stay plain and compare cleanly.
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

const prefixLines = (text, prefix) =>
  String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
const replaced = (oldText, newText) => `${prefixLines(oldText, "-")}\n${prefixLines(newText, "+")}`;

// Claude's edit tools carry the whole change in their input; show it as a minimal diff.
function claudeEditDiff(toolName, input) {
  if (toolName === "Edit") return capText(replaced(input.old_string, input.new_string));
  if (toolName === "MultiEdit") return capText((input.edits ?? []).map((edit) => replaced(edit.old_string, edit.new_string)).join("\n@@\n"));
  if (toolName === "Write") return capText(prefixLines(input.content, "+"));
  return capText(prefixLines(input.new_source, "+"));
}

// canUseTool(toolName, input, options) -> request. The SDK's own title, displayName and description win.
function claudeRequest(toolName, input, options = {}) {
  const base = {
    requestId: String(options.requestId ?? options.toolUseID),
    tool: options.displayName || toolName,
    description: options.description || undefined,
    reason: options.decisionReason || (options.blockedPath ? `Reaches outside this chat's folder: ${options.blockedPath}` : undefined),
    allowForChat: Boolean(options.suggestions?.length) && !options.suppressAlwaysAllowRule,
    stepId: options.toolUseID || undefined,
  };
  if (toolName === "Bash") return compact({ ...base, kind: "command", title: options.title || "Run this command?", command: String(input.command ?? "") });
  if (EDIT_TOOLS.has(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    const verb = toolName === "Write" ? "Write" : "Edit";
    return compact({
      ...base,
      kind: "edit",
      title: options.title || `${verb} ${path.basename(file) || "a file"}?`,
      files: file ? [file] : [],
      diff: claudeEditDiff(toolName, input),
    });
  }
  return compact({ ...base, kind: "other", title: options.title || `Use ${toolName}?`, detail: capText(JSON.stringify(input, null, 2)) });
}

// The user's answer -> the SDK's PermissionResult. Chat-wide rules are kept in the session only,
// so they never reach the user's settings files.
function claudeResult(decision, input, suggestions = []) {
  if (decision === "allow") return { behavior: "allow", updatedInput: input };
  if (decision === "allow-for-chat")
    return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions.map((update) => ({ ...update, destination: "session" })) };
  if (decision === "cancelled") return { behavior: "deny", message: CANCELLED_MESSAGE, interrupt: true };
  return { behavior: "deny", message: DENIED_MESSAGE };
}

// Codex runs commands through the user's login shell: `/bin/zsh -lc 'npm test'` or `/bin/zsh -lc ls`.
// The card shows `npm test` or `ls`. Handles both quoted and unquoted single-word forms.
function unwrapShell(command) {
  const match = /^\/(?:usr\/)?bin\/(?:ba|z)?sh -lc (?:'((?:[^']|'\\'')*)'|([^ ]+))$/.exec(command);
  if (match) {
    const quoted = match[1];
    const unquoted = match[2];
    return quoted !== undefined ? quoted.replace(/'\\''/g, "'") : unquoted;
  }
  return command;
}

// item/commandExecution/requestApproval params -> request.
function codexCommandRequest(id, params) {
  const host = params.networkApprovalContext?.host;
  return compact({
    requestId: String(id),
    kind: "command",
    tool: "Shell",
    title: host ? `Allow network access to ${host}?` : "Run this command?",
    command: unwrapShell(String(params.command ?? "")),
    cwd: params.cwd ?? undefined,
    reason: params.reason ?? undefined,
    allowForChat: true,
    stepId: params.itemId ?? undefined,
  });
}

// Codex sends an added file's content (and a deleted file's old content) as the diff, with no
// markers. Mark each line so the card shows it as added or removed; real unified diffs pass through.
function markedDiff(change) {
  const diff = change.diff ?? "";
  const mark = change.kind?.type === "add" ? "+" : change.kind?.type === "delete" ? "-" : null;
  if (!mark || !diff || /^(@@ |--- |diff --git )/m.test(diff)) return diff;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => mark + line).join("\n") + (diff.endsWith("\n") ? "\n" : "");
}

// The changes of a Codex fileChange as diff text, each under a `--- path` header. Used by the
// approval card and the step rows, so both show the same thing.
function codexChangesDiff(changes) {
  return capText(changes.map((change) => `--- ${change.path}\n${markedDiff(change)}`).join("\n"));
}

// item/fileChange/requestApproval params -> request. The request has no diff of its own; `changes`
// are the ones the matching fileChange item reported in item/started.
function codexFileRequest(id, params, changes = []) {
  const files = changes.map((change) => change.path);
  const title = params.grantRoot
    ? `Allow writing to ${params.grantRoot}?`
    : files.length === 1
      ? `Edit ${path.basename(files[0])}?`
      : files.length
        ? `Edit ${files.length} files?`
        : "Edit files?";
  return compact({
    requestId: String(id),
    kind: "edit",
    tool: "Edit files",
    title,
    files,
    diff: changes.length ? codexChangesDiff(changes) : undefined,
    reason: params.reason ?? undefined,
    allowForChat: true,
    stepId: params.itemId ?? undefined,
  });
}

// Codex 0.160 asks about MCP calls through elicitation, with an empty form and tool details
// in _meta. Other elicitation forms need user input that a permission card cannot collect.
function isCodexMcpApproval(params) {
  const { _meta: meta, requestedSchema: schema } = params;
  return (
    params.mode === "form" &&
    meta?.codex_approval_kind === "mcp_tool_call" &&
    schema?.type === "object" &&
    Boolean(schema.properties) &&
    !Object.keys(schema.properties).length &&
    !(schema.required?.length ?? 0)
  );
}

function codexMcpRequest(id, params) {
  if (!isCodexMcpApproval(params)) return null;
  const { _meta: meta } = params;
  return compact({
    requestId: String(id),
    kind: "other",
    tool: `MCP: ${params.serverName}`,
    title: params.message || `Use ${params.serverName}?`,
    description: typeof meta.tool_description === "string" ? capText(meta.tool_description) : undefined,
    detail: meta.tool_params === undefined ? undefined : capText(JSON.stringify(meta.tool_params, null, 2)),
    // Approve this call only. Never send the provider's "always" persistence choice.
    allowForChat: false,
  });
}

// Milagre's own task and phase tools only write the Chat's own plan, so every permission mode lets them run
// without a card. Codex names the tool only in the message: `Allow the milagre MCP server to run tool "tasks_set"?`.
const PLAN_TOOLS = new Set(PLAN_TOOL_NAMES);

function isCodexPlanToolApproval(params = {}) {
  if (params.serverName !== "milagre" || !isCodexMcpApproval(params)) return false;
  const tool = /^Allow the milagre MCP server to run tool "([^"]+)"\?$/.exec(String(params.message ?? ""))?.[1];
  return PLAN_TOOLS.has(tool);
}

// session/request_permission params. Antigravity's tool call carries the MCP server and tool in _meta.mcp.
function isAcpPlanToolPermission(params = {}) {
  const { _meta: meta } = params.toolCall ?? {};
  const mcp = meta?.mcp;
  return mcp?.server === "milagre" && PLAN_TOOLS.has(mcp.tool);
}

function codexMcpResponse(decision) {
  if (decision === "allow") return { action: "accept", content: {} };
  return { action: decision === "cancelled" ? "cancel" : "decline", content: null };
}

const CODEX_DECISIONS = { allow: "accept", "allow-for-chat": "acceptForSession", deny: "decline", cancelled: "cancel" };

function codexDecision(decision) {
  return CODEX_DECISIONS[decision] ?? "decline";
}

// Milagre permission modes a running turn can switch to. Bot rules is set by a bot, never offered to the user.
const PERMISSION_MODES = new Set(["ask", "auto", "full", "bot"]);

// True when every path is inside root.
function insideRoot(root, files) {
  return files.every((file) => {
    const relative = path.relative(root, path.resolve(root, file));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

// Resolve existing ancestors as well as new files, so an alias cannot escape an owned root.
function insideWorkspace(roots, files, cwd = roots[0]) {
  const { realpathSync } = require("node:fs");
  const resolve = (value) => {
    try {
      return realpathSync(value);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(value);
      if (parent === value) throw error;
      return path.join(resolve(parent), path.basename(value));
    }
  };
  try {
    const canonical = roots.map((root) => realpathSync(root));
    return (
      files.length > 0 &&
      files.every((file) => {
        const resolved = resolve(path.resolve(cwd, file));
        return canonical.some((root) => {
          const relative = path.relative(root, resolved);
          return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
        });
      })
    );
  } catch {
    return false;
  }
}

// The approval requests a session is waiting on. Each is answered exactly once: by the user, or as
// cancelled when its turn stops. `forget` drops one the agent withdrew without replying to it.
// The mode follows the user's switch mid-turn. Full answers every request without a card. Switching
// to Auto answers the waiting edits Auto wouldn't have asked about (`inWorkspace`); later ones are left
// to the agent's own Auto rules, which still ask before anything leaves the worktree.
// In Bot rules the bot's `policy(request)` answers first: "allow" or "deny" without a card, `{ gate }`
// for a sign-off card that carries the gate, nothing (or a throw) for an ordinary card.
class PendingPermissions {
  constructor(emit, { policy } = {}) {
    this.emit = emit;
    this.policy = policy;
    this.mode = "ask";
    // requestId -> { answer, allowForChat, inWorkspace }
    this.answers = new Map();
  }

  get size() {
    return this.answers.size;
  }

  add(request, answer, { inWorkspace = false } = {}) {
    if (this.mode === "full") {
      answer("allow");
      return;
    }
    let published = request;
    if (this.mode === "bot" && this.policy) {
      const verdict = this.decide(request);
      if (verdict === "allow" || verdict === "deny") {
        answer(verdict);
        return;
      }
      // A sign-off is for this one action: "Always allow in this chat" would let the agent skip the gate next time.
      if (verdict?.gate) published = { ...request, gate: verdict.gate, allowForChat: false };
    }
    this.answers.set(published.requestId, { answer, allowForChat: Boolean(published.allowForChat), inWorkspace: published.kind === "edit" && inWorkspace });
    this.emit({ type: "permission-request", ...published });
  }

  // A policy that fails leaves the request to the user's card.
  decide(request) {
    try {
      return this.policy(request);
    } catch (error) {
      console.warn("Bot permission policy failed:", error.message);
      return undefined;
    }
  }

  setMode(mode) {
    this.mode = mode;
    for (const [requestId, pending] of [...this.answers]) {
      if (mode === "full" || (mode === "auto" && pending.inWorkspace)) this.resolve(requestId, "allow");
    }
  }

  resolve(requestId, decision) {
    const pending = this.answers.get(requestId);
    if (!pending) return false;
    this.answers.delete(requestId);
    // A card that didn't offer "always allow" can't grant it.
    const given = decision === "allow-for-chat" && !pending.allowForChat ? "allow" : decision;
    pending.answer(given);
    this.emit({ type: "permission-resolved", requestId, decision: given });
    return true;
  }

  forget(requestId) {
    if (!this.answers.delete(requestId)) return false;
    this.emit({ type: "permission-resolved", requestId, decision: "cancelled" });
    return true;
  }

  cancelAll() {
    for (const requestId of [...this.answers.keys()]) this.resolve(requestId, "cancelled");
  }
}

module.exports = {
  CANCELLED_MESSAGE,
  DENIED_MESSAGE,
  PERMISSION_MODES,
  USER_DECISIONS,
  PendingPermissions,
  capText,
  claudeEditDiff,
  insideRoot,
  insideWorkspace,
  isAcpPlanToolPermission,
  isCodexPlanToolApproval,
  claudeRequest,
  claudeResult,
  codexChangesDiff,
  codexCommandRequest,
  codexDecision,
  codexFileRequest,
  codexMcpRequest,
  codexMcpResponse,
  unwrapShell,
};
