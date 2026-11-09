const path = require("node:path");
const { capText } = require("./permissions.cjs");
const { capOutput, code, routineRef, thinkingEnd, thinkingStep } = require("./steps.cjs");
const { acpPlanTasks } = require("./tasks.cjs");
const { toolMetadata } = require("@milagre/shared/tool-activity");

// ACP session/update notifications -> Milagre's AgentEvents (see steps.cjs for the step shapes). The
// mapper keeps its own state per session:
//   turnId, hasText, textBreak   the reply streaming now; a tool call or thinking between two runs of
//                                text starts a new paragraph
//   thinking                     the thinking step streaming now ({ id, text, startedAt })
//   calls                        tool calls by toolCallId, merged from tool_call and tool_call_update
//   steps                        ids of the tool steps started and not yet completed
//   editDiffs                    diffs from edit calls that only asked for approval, by path
// Verified against Antigravity 1.3.0: a command's call goes pending (asking) -> in_progress -> completed.
// An edit asks with one call ("Run create_file?", with the diff) and runs as another ("Running edit_file",
// no diff); the asking call is closed later as failed, "approved but never executed". So a call becomes a
// step once it runs, and an edit borrows the diff its approval showed.

const text = (value) => (typeof value === "string" ? value : "");
const first = (object, keys) => {
  for (const key of keys) if (typeof object?.[key] === "string" && object[key]) return object[key];
  return undefined;
};
const now = (state) => (state.now ?? Date.now)();
const normalize = (value) => text(value).replace(/\r\n/g, "\n");

const COMMAND_KEYS = ["CommandLine", "command_line", "commandLine", "command", "cmd"];
const CWD_KEYS = ["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"];
const PATH_KEYS = ["AbsolutePath", "TargetFile", "file_path", "filePath", "path", "File", "file"];
const OUTPUT_KEYS = ["combinedOutput", "combined_output", "output", "stdout"];

// ACP's extension field, `_meta`.
const meta = (object) => object?.["_meta"] ?? {};

// Whether a diff creates its file: Antigravity says so in _meta.kind; a missing oldText means it too.
const createsFile = (diff) => Boolean(diff) && (meta(diff).kind === "add" || diff.oldText === null || diff.oldText === undefined);

const isQuestionCall = (id) => String(id ?? "").startsWith("interaction_");

function commandOf(call) {
  return first(call.rawInput, COMMAND_KEYS) ?? first(call.rawOutput, COMMAND_KEYS) ?? (call.kind === "execute" ? text(call.title) : "");
}

function cwdOf(call) {
  return first(call.rawInput, CWD_KEYS) ?? first(call.rawOutput, CWD_KEYS);
}

function diffsOf(call) {
  return (Array.isArray(call.content) ? call.content : []).filter((item) => item?.type === "diff" && typeof item.path === "string");
}

function fileOf(call) {
  return call.locations?.find((location) => typeof location?.path === "string")?.path ?? diffsOf(call)[0]?.path ?? first(call.rawInput, PATH_KEYS);
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item?.type === "content" && item.content?.type === "text" ? item.content.text : ""))
    .filter(Boolean)
    .join("\n");
}

function rawText(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  const output = first(raw, OUTPUT_KEYS);
  if (output !== undefined) return output;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return "";
  }
}

// One ACP diff { path, oldText, newText } as a unified diff: lines shared at the start and the end are
// left out, the rest shows as removed and added. A missing oldText is a new file.
function splitLines(value) {
  const lines = normalize(value).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function acpDiff({ path: file, oldText, newText }) {
  const split = splitLines;
  const before = oldText === null || oldText === undefined ? [] : split(oldText);
  const after = split(newText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const header = `@@ -${removed.length ? start + 1 : start},${removed.length} +${added.length ? start + 1 : start},${added.length} @@`;
  return [`--- ${file}`, `+++ ${file}`, header, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
}

const acpDiffText = (diffs) => (diffs.length ? capText(diffs.map(acpDiff).join("\n")) : undefined);

function editVerb(call, diffs) {
  if (call.kind === "delete") return "Deleted";
  if (call.kind === "move") return "Moved";
  const diff = diffs[0];
  if (createsFile(diff)) return "Created";
  if (meta(diff).kind === "delete") return "Deleted";
  return "Edited";
}

// "Running view_file", "Run create_file?" -> "view_file".
function toolName(call) {
  const title = text(call.title).trim();
  return /^(?:Running|Run)\s+([\w.:-]+)\??$/.exec(title)?.[1] ?? title;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// A tool call -> the start of its step.
function acpStep(call, diffs = diffsOf(call)) {
  const id = String(call.toolCallId);
  const file = fileOf(call);
  const mcp = meta(call).mcp;
  const metadata = mcp?.server && mcp?.tool ? toolMetadata(mcp.server, mcp.tool, call.rawInput) : {};
  const step = (kind, title, detail, stepFile) => compact({ id, kind, title, detail, file: stepFile, ...metadata });
  switch (call.kind) {
    case "execute": {
      const command = commandOf(call);
      return step("shell", command ? `Ran ${code(command)}` : "Ran a command", capOutput(`$ ${command}\n`));
    }
    case "read":
      return step("read", file ? `Read ${code(path.basename(file))}` : text(call.title) || "Read a file", undefined, file);
    case "edit":
    case "delete":
    case "move":
      return step("edit", `${editVerb(call, diffs)} ${file ? code(path.basename(file)) : "a file"}`, undefined, file);
    case "search": {
      const query = first(call.rawInput, ["Query", "query", "pattern", "Pattern"]);
      return step("search", query ? `Searched for ${code(query)}` : text(call.title) || "Searched");
    }
    case "fetch": {
      const url = first(call.rawInput, ["Url", "url", "URL"]);
      return step("other", url ? `Fetched ${code(url)}` : text(call.title) || "Fetched a page");
    }
    default: {
      const name = toolName(call);
      if (meta(call).is_mcp_tool_call) return step("other", name ? `Used ${code(name)}` : "Used a tool");
      return step("other", name ? (/\s/.test(name) ? name : `Used ${code(name)}`) : "Used a tool");
    }
  }
}

const isHeartbeatCreate = (call) => {
  const mcp = meta(call).mcp;
  return mcp && typeof mcp === "object" ? mcp.server === "milagre" && mcp.tool === "heartbeat_create" : toolName(call) === "milagre_heartbeat_create";
};

// A finished tool call -> the end of its step.
function acpStepResult(call, diffs = diffsOf(call)) {
  const id = String(call.toolCallId);
  const exitCode = call.rawOutput && typeof call.rawOutput === "object" ? (call.rawOutput.exitCode ?? call.rawOutput.exit_code) : undefined;
  const failed = call.status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  const status = failed ? "failed" : "done";
  const output = normalize(contentText(call.content) || rawText(call.rawOutput));
  if (call.kind === "execute") return { id, status, detail: capOutput(`$ ${commandOf(call)}\n${output}`) };
  if (failed) return compact({ id, status, detail: output ? capText(output) : undefined });
  if (call.kind === "read") return { id, status };
  if (["edit", "delete", "move"].includes(call.kind)) return compact({ id, status, title: acpStep(call, diffs).title, detail: acpDiffText(diffs) });
  // Milagre's heartbeat_create starts its result with a JSON line naming the Heartbeat: the step carries it, the detail doesn't.
  if (isHeartbeatCreate(call)) {
    const { routine, detail } = routineRef(output);
    if (routine) return compact({ id, status, routine, detail: detail ? capText(detail) : undefined });
  }
  return compact({ id, status, detail: output ? capText(output) : undefined });
}

function textDelta(state, value) {
  const events = [];
  if (state.hasText && state.textBreak) events.push({ type: "text-delta", messageId: state.turnId, text: "\n\n", startsMessage: true });
  state.textBreak = false;
  state.hasText = true;
  events.push({ type: "text-delta", messageId: state.turnId, text: value });
  return events;
}

// The thinking step streaming now, ended.
function closeThinking(state) {
  const thinking = state.thinking;
  if (!thinking) return [];
  state.thinking = null;
  return [{ type: "step-completed", ...thinkingEnd(thinking.id, now(state) - thinking.startedAt, thinking.text) }];
}

function toolEvents(update, state) {
  const id = String(update.toolCallId ?? "");
  if (!id || isQuestionCall(id)) return [];
  state.calls ??= new Map();
  state.steps ??= new Set();
  state.editDiffs ??= new Map();
  const previous = state.calls.get(id) ?? {};
  const call = { ...previous };
  for (const [key, value] of Object.entries(update)) if (key !== "sessionUpdate" && value !== undefined) call[key] = value;
  if (update.rawInput && previous.rawInput) call.rawInput = { ...previous.rawInput, ...update.rawInput };
  state.calls.set(id, call);
  const status = call.status ?? "in_progress";
  const own = diffsOf(call);
  // An edit asking for approval: its diff is kept for the call that runs it.
  if (status === "pending") {
    for (const diff of own)
      state.editDiffs.set(
        diff.path,
        own.filter((item) => item.path === diff.path),
      );
    return [];
  }
  const file = fileOf(call);
  const diffs = own.length ? own : ((file && state.editDiffs.get(file)) ?? []);
  const events = closeThinking(state);
  state.textBreak = true;
  const started = state.steps.has(id);
  if (status === "completed" || status === "failed") {
    state.calls.delete(id);
    if (file && !own.length) state.editDiffs.delete(file);
    // The approval call of an edit that ran as another call.
    if (!started && status === "failed" && /approved but never executed/i.test(rawText(call.rawOutput))) return [];
    if (started) state.steps.delete(id);
    else events.push({ type: "step-started", step: acpStep(call, diffs) });
    events.push({ type: "step-completed", ...acpStepResult(call, diffs) });
    return events;
  }
  if (!started) {
    state.steps.add(id);
    events.push({ type: "step-started", step: acpStep(call, diffs) });
  }
  return events;
}

// session/update's `update` -> events.
function mapAcpUpdate(update, state) {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const value = update.content?.type === "text" ? text(update.content.text) : "";
      if (!value) return [];
      return [...closeThinking(state), ...textDelta(state, value)];
    }
    case "agent_thought_chunk": {
      const value = update.content?.type === "text" ? text(update.content.text) : "";
      if (!value) return [];
      const events = [];
      if (!state.thinking) {
        state.thinkingCount = (state.thinkingCount ?? 0) + 1;
        state.thinking = { id: `thinking-${state.thinkingCount}`, text: "", startedAt: now(state) };
        state.textBreak = true;
        events.push({ type: "step-started", step: thinkingStep(state.thinking.id) });
      }
      state.thinking.text += value;
      events.push({ type: "step-output", id: state.thinking.id, text: value });
      return events;
    }
    case "tool_call":
    case "tool_call_update":
      return toolEvents(update, state);
    case "plan": {
      const tasks = acpPlanTasks(update.entries);
      return tasks ? [{ type: "tasks-updated", tasks }] : [];
    }
    case "usage_update":
      return typeof update.used === "number" && update.size > 0 ? [{ type: "context-usage", used: update.used, size: update.size }] : [];
    case "current_mode_update":
      if (typeof update.currentModeId === "string") state.mode = update.currentModeId;
      return [];
    case "config_option_update":
      readConfigOptions(update.configOptions, state);
      return [];
    case "session_info_update": {
      // Kiro's turn summary, just before the turn ends: what its prompts cost, in credits.
      const { _meta: meta } = update;
      const summaries = meta?.kiro?.kind === "turn_completion" ? meta.kiro.promptTurnSummaries : null;
      const credits = Array.isArray(summaries) ? summaries.filter((item) => item?.unit === "credit" && Number.isFinite(item.usage)) : [];
      if (credits.length) state.turnCredits = credits.reduce((sum, item) => sum + item.usage, 0);
      return [];
    }
    default:
      return [];
  }
}

// The session's model and mode, and the models it offers, from configOptions.
function readConfigOptions(options, state) {
  if (!Array.isArray(options)) return;
  for (const option of options) {
    if (option?.id === "model" || option?.category === "model") {
      if (typeof option.currentValue === "string") state.model = option.currentValue;
      if (Array.isArray(option.options)) state.models = option.options.filter((item) => typeof item?.value === "string");
    }
    if ((option?.id === "mode" || option?.category === "mode") && typeof option.currentValue === "string") state.mode = option.currentValue;
    // Kiro's permission mode, a switch of its own (see kiro-acp.cjs).
    if (option?.id === "autopilot" && typeof option.currentValue === "string") state.autopilot = option.currentValue;
  }
  // Kiro's effort follows the model: offered at the model's default after a switch, absent for a model without efforts.
  if (options.some((option) => option?.id === "model")) state.effortLevel = options.find((option) => option?.id === "effortLevel")?.currentValue;
}

// session/prompt's stopReason -> the turn's end.
function stopReasonEvent(stopReason, name) {
  if (stopReason === "cancelled") return { type: "turn-cancelled" };
  if (stopReason === "max_tokens") return { type: "turn-failed", message: `${name} stopped: the reply reached its length limit.` };
  if (stopReason === "max_turn_requests") return { type: "turn-failed", message: `${name} stopped: the turn reached its limit of model requests.` };
  if (stopReason === "refusal") return { type: "turn-failed", message: `${name} declined to continue this turn.` };
  return { type: "turn-completed" };
}

module.exports = {
  createsFile,
  acpDiff,
  acpStep,
  acpStepResult,
  closeThinking,
  isQuestionCall,
  mapAcpUpdate,
  readConfigOptions,
  stopReasonEvent,
  commandOf,
  cwdOf,
  diffsOf,
  fileOf,
  acpDiffText,
};
