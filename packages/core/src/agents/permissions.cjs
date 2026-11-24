const path = require("node:path");
const { PLAN_TOOL_NAMES } = require("../chat-plan-tools.cjs");
const { TASK_BLOCKED_TOOL } = require("@milagre/shared/orchestrator");
const { ROUTINE_TOOL_NAMES } = require("../routines/tools.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");
const { BUNDLED_SKILLS_DIRECTORY } = require("../bundled-skills.cjs");

const DENIED_MESSAGE = "Denied in Milagre";
const CANCELLED_MESSAGE = "The turn was cancelled in Milagre.";
const USER_DECISIONS = new Set(["allow", "allow-for-chat", "deny"]);
const MAX_TEXT = 20_000;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function capText(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… truncated` : text;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

const prefixLines = (text, prefix) =>
  String(text ?? "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
const replaced = (oldText, newText) => `${prefixLines(oldText, "-")}\n${prefixLines(newText, "+")}`;

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
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const name = mcp ? `${mcp[2]} from ${mcp[1]}` : toolName;
  return compact({ ...base, kind: "other", title: options.title || `Use ${name}?`, detail: capText(JSON.stringify(input, null, 2)) });
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
function claudeAccessRequest(toolName, input, request) {
  const file = READ_TOOLS.has(toolName) ? (input?.file_path ?? input?.path) : undefined;
  return typeof file === "string" && file ? { kind: "read", files: [file] } : request;
}

// The user's answer -> the SDK's PermissionResult. Chat-wide rules are kept in the session only,
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

const writesRemote = (command) => babysitDenial(command, { level: 1, resolveThreads: false }) !== null;

function codexCommandRequest(id, params) {
  const host = params.networkApprovalContext?.host;
  const command = unwrapShell(String(params.command ?? ""));
  return compact({
    requestId: String(id),
    kind: "command",
    tool: "Shell",
    title: host ? `Allow network access to ${host}?` : "Run this command?",
    command,
    cwd: params.cwd ?? undefined,
    reason: params.reason ?? undefined,
    allowForChat: !writesRemote(command),
    stepId: params.itemId ?? undefined,
  });
}

// Codex sends an added file's content (and a deleted file's old content) as the diff, with no
function markedDiff(change) {
  const diff = change.diff ?? "";
  const mark = change.kind?.type === "add" ? "+" : change.kind?.type === "delete" ? "-" : null;
  if (!mark || !diff || /^(@@ |--- |diff --git )/m.test(diff)) return diff;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => mark + line).join("\n") + (diff.endsWith("\n") ? "\n" : "");
}

// The changes of a Codex fileChange as diff text, each under a `--- path` header. Used by the
function codexChangesDiff(changes) {
  return capText(changes.map((change) => `--- ${change.path}\n${markedDiff(change)}`).join("\n"));
}

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
    allowForChat: false,
  });
}

// Codex names the tool only in the message: `Allow the milagre MCP server to run tool "tasks_set"?`.
const SELF_GATED_TOOLS = [
  "request_secret",
  "report_milagre_bug",
  "project_add",
  "import_run",
  "worktree_link",
  "worktree_remove",
  "chat_set_mode",
  "chat_respond",
  "delegate",
  "desktop_act",
  "desktop_press",
  "desktop_launch",
];
const OWN_CHAT_TOOLS = [
  "design_show",
  "design_apply",
  "artifact_show",
  "html_render",
  "artifact_resolve_comment",
  "browser_open",
  "browser_close",
  "browser_resolve_comment",
  "conclude_negotiation",
  "flow_step_output",
  TASK_BLOCKED_TOOL,
];
const ROUTINE_READS = ROUTINE_TOOL_NAMES.filter((name) => name === "routine_list");
const PLAN_TOOLS = new Set([...PLAN_TOOL_NAMES, ...ROUTINE_READS, ...SELF_GATED_TOOLS, ...OWN_CHAT_TOOLS]);

/**
 * The milagre tools a provider runs without its own card, in every mode: the reads, the plan tools, routine_list, the ones that only
 * write the Chat's own canvas, page or Negotiation, and the self-gated ones. Every other milagre tool (Linear writes,
 * chat_stop, worktree_create, design_delete…) follows the Chat's permission mode like any tool. Claude takes this list as
 * allowedTools. Codex skips its own card for readOnlyHint tools, and Milagre answers the card Codex or Antigravity shows
 * for the rest of the list (isCodexPlanToolApproval, isAcpPlanToolPermission).
 */
const isUngatedMilagreTool = (definition) => definition.readOnly === true || PLAN_TOOLS.has(definition.name);

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

const PERMISSION_MODES = new Set(["ask", "auto", "full"]);
const MODE_RANK = Object.freeze({ ask: 0, auto: 1, full: 2 });
const callerMode = (mode) => (Object.hasOwn(MODE_RANK, mode ?? "") ? mode : "ask");
const modeRank = (mode) => (Object.hasOwn(MODE_RANK, mode ?? "") ? MODE_RANK[mode] : Infinity);
const raisesMode = (mode, caller) => modeRank(mode) > MODE_RANK[callerMode(caller)];
const turnMode = (mode) => (mode == null || PERMISSION_MODES.has(mode) ? mode : "ask");

function askForUnknownModes(state) {
  const unknown = (turn) => turn?.permissionMode != null && !PERMISSION_MODES.has(turn.permissionMode);
  const asked = (turn) => (unknown(turn) ? { ...turn, permissionMode: "ask" } : turn);
  let sessions = null;
  for (const [id, session] of Object.entries(state?.sessions ?? {})) {
    const queued = session.queued?.some((entry) => unknown(entry.turn));
    if (!unknown(session) && !unknown(session.resumeTurn) && !unknown(session.limitTurn?.turn) && !unknown(session.limitResume?.turn) && !queued) continue;
    sessions ??= { ...state.sessions };
    sessions[id] = {
      ...asked(session),
      ...(session.resumeTurn ? { resumeTurn: asked(session.resumeTurn) } : {}),
      ...(session.limitTurn ? { limitTurn: { ...session.limitTurn, turn: asked(session.limitTurn.turn) } } : {}),
      ...(session.limitResume ? { limitResume: { ...session.limitResume, turn: asked(session.limitResume.turn) } } : {}),
      ...(queued ? { queued: session.queued.map((entry) => (entry.turn ? { ...entry, turn: asked(entry.turn) } : entry)) } : {}),
    };
  }
  return sessions ? { ...state, sessions } : state;
}

function insideRoot(root, files) {
  return files.every((file) => {
    const relative = path.relative(root, path.resolve(root, file));
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

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

const PENDING_WORKTREE_MESSAGE =
  "This Project has no Worktree in this Chat yet, and its main checkout is read-only. Call the milagre link_worktree_create tool with the Project's name, then make the change in the Worktree it returns.";

class WorkspaceAccess {
  constructor({ cwd, workspaceRoots, readOnlyRoots = [], skillsDirectory = BUNDLED_SKILLS_DIRECTORY }) {
    Object.assign(this, { cwd, roots: workspaceRoots, readOnlyRoots, skillsDirectory, known: [...(workspaceRoots ?? [])] });
  }

  contains(files) {
    return files.length > 0 && (this.roots ? insideWorkspace([this.cwd, ...this.roots], files, this.cwd) : insideRoot(this.cwd, files));
  }

  own(workspaceRoots, readOnlyRoots) {
    Object.assign(this, { roots: workspaceRoots, readOnlyRoots });
  }

  learned(roots = this.roots ?? []) {
    this.known = [...new Set([...this.known, ...roots])];
  }

  answer({ kind, files = [] }, mode) {
    if (!files.length) return null;
    const inside = (roots) => roots.some((root) => insideWorkspace([root], files, this.cwd));
    if (kind === "read" && inside([this.skillsDirectory])) return { decision: "allow", learn: [] };
    if (inside(this.readOnlyRoots)) {
      if (kind === "edit") return { decision: "deny", message: PENDING_WORKTREE_MESSAGE };
      return kind === "read" ? { decision: "allow", learn: [] } : null;
    }
    const late = (this.roots ?? []).filter((root) => !this.known.includes(root));
    if (kind === "edit" && mode === "auto" && inside(late)) return { decision: "allow", learn: late };
    return null;
  }
}

class PendingPermissions {
  constructor(emit) {
    this.emit = emit;
    this.mode = "ask";
    this.answers = new Map();
  }

  add(request, answer, { inWorkspace = false } = {}) {
    if (this.mode === "full") {
      answer("allow");
      return;
    }
    this.answers.set(request.requestId, { answer, allowForChat: Boolean(request.allowForChat), inWorkspace: request.kind === "edit" && inWorkspace });
    this.emit({ type: "permission-request", ...request });
  }

  setMode(mode) {
    this.mode = mode;
    for (const [requestId, pending] of Array.from(this.answers)) {
      if (mode === "full" || (mode === "auto" && pending.inWorkspace)) this.resolve(requestId, "allow");
    }
  }

  resolve(requestId, decision) {
    const pending = this.answers.get(requestId);
    if (!pending) return false;
    this.answers.delete(requestId);
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
    for (const requestId of Array.from(this.answers.keys())) this.resolve(requestId, "cancelled");
  }
}

module.exports = {
  CANCELLED_MESSAGE,
  DENIED_MESSAGE,
  MODE_RANK,
  PERMISSION_MODES,
  USER_DECISIONS,
  PendingPermissions,
  capText,
  claudeEditDiff,
  insideRoot,
  insideWorkspace,
  callerMode,
  isAcpPlanToolPermission,
  isCodexPlanToolApproval,
  isUngatedMilagreTool,
  modeRank,
  raisesMode,
  turnMode,
  askForUnknownModes,
  WorkspaceAccess,
  claudeAccessRequest,
  claudeRequest,
  claudeResult,
  codexChangesDiff,
  codexCommandRequest,
  codexDecision,
  codexFileRequest,
  codexMcpRequest,
  codexMcpResponse,
  unwrapShell,
  writesRemote,
};
