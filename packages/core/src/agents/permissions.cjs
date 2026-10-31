const path = require("node:path");
const { PLAN_TOOL_NAMES } = require("../chat-plan-tools.cjs");
const { ROUTINE_TOOL_NAMES } = require("../routines/tools.cjs");
const { BOT_TOOL_NAMES } = require("../bots/tools.cjs");
const { babysitDenial } = require("../babysit-guard.cjs");

// Approval requests from both agents, in the shape of the `permission-request` event, and the
// replies each agent expects for the user's answer. A request is
//   { requestId, kind: "command"|"edit"|"other", tool, toolName?, title, description?, command?, cwd?,
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

// canUseTool(toolName, input, options) -> request. The SDK's own title, displayName and description win; `toolName`
// keeps the tool's own name when the card shows another, for what matches on it (bots/gates.cjs).
function claudeRequest(toolName, input, options = {}) {
  const base = {
    requestId: String(options.requestId ?? options.toolUseID),
    tool: options.displayName || toolName,
    toolName: options.displayName && options.displayName !== toolName ? toolName : undefined,
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
  // An MCP tool reads as its step row does: `mcp__milagre__chat_stop` -> "chat_stop from milagre".
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const name = mcp ? `${mcp[2]} from ${mcp[1]}` : toolName;
  return compact({ ...base, kind: "other", title: options.title || `Use ${name}?`, detail: capText(JSON.stringify(input, null, 2)) });
}

// What a Claude tool call reaches, for WorkspaceAccess: a read tool's path (Grep and Glob without one search the cwd),
// else the permission card's own request.
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
function claudeAccessRequest(toolName, input, request) {
  const file = READ_TOOLS.has(toolName) ? (input?.file_path ?? input?.path) : undefined;
  return typeof file === "string" && file ? { kind: "read", files: [file] } : request;
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

// Whether a shell command writes to GitHub (pushes, replies, merges…): what the lowest babysit level refuses. Such a
// command is only ever allowed once. An agent that cached "allow for this Chat" would run it again without asking, so
// a later babysit Run's guard would never see it.
const writesRemote = (command) => babysitDenial(command, { level: 1, resolveThreads: false }) !== null;

// item/commandExecution/requestApproval params -> request.
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

// Milagre's own task and phase tools only write the Chat's own plan, so every permission mode lets them run without a
// card. Of the routine tools only routine_list does: a Routine's writes (setting, changing, deleting or running one)
// follow the Chat's permission mode like any other change (ruling 2026-10-17). The self-gated tools ask on Milagre's own card
// when they widen access (local-mcp-host.cjs), with what they would do; the provider's bare "run tool?" card in front
// of it would make the user approve twice.
// Codex names the tool only in the message: `Allow the milagre MCP server to run tool "tasks_set"?`.
// Computer use asks once per app per Chat itself (computer-use.cjs), so its acting tools skip the mode's per-call card.
const SELF_GATED_TOOLS = [
  "request_secret",
  "project_add",
  "worktree_link",
  "worktree_remove",
  "chat_set_mode",
  "chat_respond",
  "delegate",
  "desktop_act",
  "desktop_press",
  "desktop_launch",
];
// Like the plan tools, these only write the Chat's own canvas, page, Browser panel or Negotiation (design_delete stays
// gated; so do the browser tools that act on a page, a click or a typed value).
const OWN_CHAT_TOOLS = [
  "design_show",
  "design_apply",
  "artifact_show",
  "artifact_resolve_comment",
  "browser_open",
  "browser_resolve_comment",
  "conclude_negotiation",
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

/**
 * The milagre tools a bot's thread and the Chats a bot opened keep: the reads, the plan tools, the ones that only write
 * the Chat's own canvas or page, and the bot's own tools. Bot rules allow what no gate matches and gates leave Milagre's
 * tools alone, so every other one (Routine writes, Delegations, Worktree Links, other Chats, Linear writes…) is withheld
 * there, and so is any milagre write tool added later until it is listed here.
 */
const BOT_RULES_TOOLS = new Set([
  ...PLAN_TOOL_NAMES,
  "design_show",
  "design_apply",
  "artifact_show",
  "artifact_resolve_comment",
  "browser_resolve_comment",
  ...BOT_TOOL_NAMES,
]);
const isBotRulesTool = (definition) => definition.readOnly === true || BOT_RULES_TOOLS.has(definition.name);

/**
 * The milagre tool a request is about, or null for any other: Claude names it `mcp__milagre__<tool>` (its card may show
 * a display name, then `toolName` keeps this), Codex only in its card's title, Antigravity in `toolName` (acp-session.cjs).
 */
function milagreToolOf(request = {}) {
  const named = /^mcp__milagre__(.+)$/.exec(request.toolName ?? request.tool ?? "")?.[1];
  if (named) return named;
  if (request.tool !== "MCP: milagre") return null;
  return /run tool "([^"]+)"/.exec(request.title ?? "")?.[1] ?? "";
}

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
// How much a permission mode allows, least first. A tool never gives a Chat more than its caller has without the user's say.
const MODE_RANK = Object.freeze({ ask: 0, auto: 1, full: 2 });
// Bot rules has no rank: what it allows hangs on the bot's gates. So that every comparison fails closed, a caller in Bot
// rules (or in no mode Milagre knows) counts as Ask, and a Chat that would run something in Bot rules counts as more
// than Full, so a tool always asks before sending it anything.
const callerMode = (mode) => (Object.hasOwn(MODE_RANK, mode ?? "") ? mode : "ask");
const modeRank = (mode) => (Object.hasOwn(MODE_RANK, mode ?? "") ? MODE_RANK[mode] : Infinity);
/** Whether running in `mode` is more than a caller in `caller` may give a Chat without the user's say. */
const raisesMode = (mode, caller) => modeRank(mode) > MODE_RANK[callerMode(caller)];

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

const PENDING_WORKTREE_MESSAGE =
  "This Project has no Worktree in this Chat yet, and its main checkout is read-only. Call the milagre link_worktree_create tool with the Project's name, then make the change in the Worktree it returns.";

/**
 * The folders a Chat's agent session works in, shared by every provider. `roots` are the Chat's own: unset for a Project
 * Chat (its cwd alone), a shared Link Chat's Worktrees otherwise. `readOnlyRoots` are the main checkouts of the Link's
 * Projects the Chat has no Worktree in yet. A Worktree the Chat makes mid-session (`own`) is the Chat's at once, before
 * the provider's own sandbox has it (`known`, which the provider updates with `learned`).
 */
class WorkspaceAccess {
  constructor({ cwd, workspaceRoots, readOnlyRoots = [] }) {
    Object.assign(this, { cwd, roots: workspaceRoots, readOnlyRoots, known: [...(workspaceRoots ?? [])] });
  }

  /** Whether every file is in the Chat's own folders: what Auto edits without asking. */
  contains(files) {
    return files.length > 0 && (this.roots ? insideWorkspace([this.cwd, ...this.roots], files, this.cwd) : insideRoot(this.cwd, files));
  }

  own(workspaceRoots, readOnlyRoots) {
    Object.assign(this, { roots: workspaceRoots, readOnlyRoots });
  }

  /** The provider's sandbox now has these roots (every owned one by default). */
  learned(roots = this.roots ?? []) {
    this.known = [...new Set([...this.known, ...roots])];
  }

  /**
   * A request decided before anyone is asked, or null: an edit in a main checkout is refused with the way to get a
   * Worktree, a read there is allowed, and in Auto an edit in a Worktree made mid-session is allowed, with the roots
   * (`learn`) the provider's sandbox should take.
   */
  answer({ kind, files = [] }, mode) {
    if (!files.length) return null;
    // Root by root: a missing folder only leaves its own requests to the usual cards.
    const inside = (roots) => roots.some((root) => insideWorkspace([root], files, this.cwd));
    if (inside(this.readOnlyRoots)) {
      if (kind === "edit") return { decision: "deny", message: PENDING_WORKTREE_MESSAGE };
      return kind === "read" ? { decision: "allow", learn: [] } : null;
    }
    const late = (this.roots ?? []).filter((root) => !this.known.includes(root));
    if (kind === "edit" && mode === "auto" && inside(late)) return { decision: "allow", learn: late };
    return null;
  }
}

// The approval requests a session is waiting on. Each is answered exactly once: by the user, or as
// cancelled when its turn stops. `forget` drops one the agent withdrew without replying to it.
// The mode follows the user's switch mid-turn. Full answers every request without a card. Switching
// to Auto answers the waiting edits Auto wouldn't have asked about (`inWorkspace`); later ones are left
// to the agent's own Auto rules, which still ask before anything leaves the worktree.
// In Bot rules the bot's `policy(request)` answers first: "allow" or "deny" without a card, `{ gate }`
// for a sign-off card that carries the gate, nothing (or a throw) for an ordinary card. `flagged` is what an
// earlier check of the same tool call found (Claude's PreToolUse hook): `{ gate }`, or `{}` when it couldn't
// tell. A flagged request is never allowed without a card. A request `fromMilagre` (askApproval: Milagre's own card for
// what one of its tools would do, such as a Delegation) is the user's to answer: Bot rules never answer it.
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

  add(request, answer, { inWorkspace = false, flagged, fromMilagre = false } = {}) {
    if (this.mode === "full") {
      answer("allow");
      return;
    }
    let published = request;
    if (this.mode === "bot" && this.policy && !fromMilagre) {
      let verdict = this.decide(request);
      if (flagged && verdict !== "deny" && !verdict?.gate) verdict = flagged.gate ? { gate: flagged.gate } : undefined;
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
    // A copy: resolving calls answers and emits events that can add requests.
    for (const [requestId, pending] of Array.from(this.answers)) {
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
    // A copy: cancellation callbacks can add requests for a later pass.
    for (const requestId of Array.from(this.answers.keys())) this.resolve(requestId, "cancelled");
  }
}

module.exports = {
  BOT_RULES_TOOLS,
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
  isBotRulesTool,
  isCodexPlanToolApproval,
  isUngatedMilagreTool,
  milagreToolOf,
  modeRank,
  raisesMode,
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
