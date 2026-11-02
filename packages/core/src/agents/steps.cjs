const path = require("node:path");
const { capText, claudeEditDiff, codexChangesDiff, unwrapShell } = require("./permissions.cjs");

// Tool steps: each command, edit, read, search or other tool call an agent makes, as the rows of
// its reply, and each stretch of thinking. A step starts as { id, kind, title, detail? } and ends as
// { id, status, title?, detail?, durationMs? }:
//   kind    "shell" | "edit" | "read" | "search" | "other" | "thinking" | "setup" | "image" | "artifact"
//   title   what it did, past tense, with code between backticks: "Ran `npm test`", "Edited `App.tsx`"
//   file    the file a read or edit worked on, as the tool named it (absolute, or relative to the chat's folder);
//           the title shows only its name, and the renderer opens it in an editor from here
//   status  "done" | "failed"
//   detail  a command and its output ("$ npm test\n…"), a unified diff, or the tool's result text.
//           The detail a step ends with replaces anything streamed into it. A read that worked keeps none.
// A title given at the end replaces the first one, for agents that only know it then.
// A thinking step streams the agent's thinking summary into its detail and ends with how long it took.
// An image step is an image the agent generated: it ends with the image's file and the prompt it was made from as its detail.
// An artifact step is a design the agent showed or edited: it ends with its reference ({ id, version, title }).

// Command output keeps its end, where results and errors are (capOutput); diffs and other details keep their start.
const { MAX_OUTPUT, capOutput } = require("@milagre/shared/agent-runs");
const { toolMetadata } = require("@milagre/shared/tool-activity");
const { ROUTINE_TOOL_NAMES } = require("../routines/tools.cjs");

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const CLAUDE_AGENT_TOOLS = new Set(["Agent", "Task"]);

// Text shown as code in a title: one line of at most 80 characters, with no backticks of its own.
function code(text, max = 80) {
  const flat = String(text ?? "")
    .trim()
    .replace(/`/g, "'")
    .replace(/\s+/g, " ");
  return `\`${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}\``;
}

// A step's file: a non-empty string, or nothing.
const filePath = (file) => (typeof file === "string" && file ? file : undefined);

const fileName = (file) => (file ? code(path.basename(String(file))) : "a file");

// Drops undefined fields so steps stay plain and compare cleanly.
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// A tool result's content is a string or a list of blocks.
function blocksText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : block?.type ? `[${block.type}]` : ""))
    .filter(Boolean)
    .join("\n");
}

// --- Artifacts ---

// Milagre's design tools show their result as a card in the Chat.
const isArtifactTool = (server, tool) => server === "milagre" && ["design_show", "design_apply", "artifact_show", "html_render"].includes(tool);
const artifactTitle = (title, tool) =>
  `${tool === "design_apply" ? "Edited" : "Showed"} ${code(title || (tool === "artifact_show" ? "an artifact" : "a design"))}`;
// The step names its tool: the Designs canvas opens when a design tool starts, not for an artifact page.
const artifactStep = (step, title, tool) => ({ ...step("artifact", artifactTitle(title, tool)), tool });
// Resolving a comment the user left on a design reads as that, not as a tool call.
const isResolveTool = (server, tool) => server === "milagre" && (tool === "artifact_resolve_comment" || tool === "browser_resolve_comment");
const resolvedTitle = (tool) => (tool === "browser_resolve_comment" ? "Resolved a page comment" : "Resolved a design comment");

// Milagre's routine tools read as what they did to the Project's Heartbeats and Routines, not as tool calls.
const ROUTINE_STEP_TOOLS = new Set(ROUTINE_TOOL_NAMES);
function routineTitle(server, tool, input = {}) {
  if (server !== "milagre" || !ROUTINE_STEP_TOOLS.has(tool)) return null;
  if (tool === "heartbeat_create") return typeof input.name === "string" && input.name ? `Set Heartbeat "${input.name}"` : "Set a Heartbeat";
  if (tool === "routine_create") return typeof input.name === "string" && input.name ? `Set Routine "${input.name}"` : "Set a Routine";
  return tool === "routine_delete" ? "Stopped a Routine" : "Checked Routines";
}

// The artifact a finished design tool made, from the first line of its result: the JSON summary. Attached images follow it.
function artifactRef(text) {
  try {
    const { id, version, title, format, group, inline, height } = JSON.parse(String(text).split("\n", 1)[0]);
    return typeof id === "string" && Number.isInteger(version) && typeof title === "string"
      ? {
          id,
          version,
          title,
          ...(inline === true ? { inline: true, ...(Number.isInteger(height) && height >= 24 && height <= 2000 ? { height } : {}) } : {}),
          ...(["design", "html"].includes(format) ? { format } : {}),
          ...(typeof group === "string" && group ? { group } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

// The Heartbeat a finished heartbeat_create set, from the first line of its result: the JSON { routine: { id, name } }.
// `detail` is the rest of the result, without that line.
function routineRef(text) {
  const [first, ...rest] = String(text).split("\n");
  try {
    const { id, name } = JSON.parse(first)?.routine ?? {};
    if (typeof id !== "string" || !id || typeof name !== "string") return {};
    return { routine: { id, name }, detail: rest.join("\n").trim() || undefined };
  } catch {
    return {};
  }
}

// --- Thinking ---

const thinkingStep = (id) => ({ id: String(id), kind: "thinking", title: "Thinking" });

// "Thought for 4s", "Thought for 1m 5s"; just "Thought" when the start wasn't seen.
function thinkingEnd(id, durationMs, text) {
  const title = durationMs === undefined ? "Thought" : `Thought for ${formatDuration(durationMs)}`;
  return compact({ id: String(id), status: "done", title, detail: text ? capText(text) : undefined, durationMs });
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// --- Claude ---

function claudeStep(id, name, input = {}) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name));
  const metadata = mcp ? toolMetadata(mcp[1], mcp[2], input) : {};
  const step = (kind, title, detail, file) => compact({ id: String(id), kind, title, detail, file: filePath(file), ...metadata });
  if (name === "Bash") return step("shell", `Ran ${code(input.command)}`, capOutput(`$ ${input.command ?? ""}\n`));
  if (name === "Read") return step("read", `Read ${fileName(input.file_path)}`, undefined, input.file_path);
  if (CLAUDE_EDIT_TOOLS.has(name))
    return step("edit", `Edited ${fileName(input.file_path ?? input.notebook_path)}`, undefined, input.file_path ?? input.notebook_path);
  if (name === "Write") return step("edit", `Wrote ${fileName(input.file_path)}`, undefined, input.file_path);
  if (name === "Grep") return step("search", `Searched for ${code(input.pattern)}${input.path ? ` in ${code(input.path)}` : ""}`);
  if (name === "Glob") return step("search", `Found files matching ${code(input.pattern)}`);
  if (name === "WebSearch") return step("search", `Searched the web for ${code(input.query)}`);
  if (name === "WebFetch") return step("other", `Fetched ${code(input.url)}`);
  if (CLAUDE_AGENT_TOOLS.has(name)) return step("other", `Ran an agent: ${input.description || "a subtask"}`);
  if (name === "TodoWrite") return step("other", "Updated the to-do list");
  if (mcp && isArtifactTool(mcp[1], mcp[2])) return artifactStep(step, input.title, mcp[2]);
  if (mcp && isResolveTool(mcp[1], mcp[2])) return step("other", resolvedTitle(mcp[2]), input.note);
  const routine = mcp && routineTitle(mcp[1], mcp[2], input);
  if (routine) return step("other", routine);
  if (mcp) return step("other", `Used ${code(mcp[2])} from ${mcp[1]}`);
  return step("other", `Used ${name}`);
}

// Claude's structured patch (Edit and Write results) as unified diff hunks.
function patchDiff(result) {
  const hunks = result?.structuredPatch;
  if (!Array.isArray(hunks) || !hunks.length) return undefined;
  return capText(
    hunks.map((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...(hunk.lines ?? [])].join("\n")).join("\n"),
  );
}

const TODO_MARKS = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

// call: the tool_use block { id, name, input }; block: its tool_result; structured: the message's
// tool_use_result, the tool's own output object.
function claudeStepResult(call, block, structured) {
  const { name, input = {} } = call;
  const failed = block.is_error === true;
  const text = blocksText(block.content);
  const end = (extra = {}) => compact({ id: String(call.id), status: failed ? "failed" : "done", ...extra });
  if (name === "Bash") return end({ detail: capOutput(`$ ${input.command ?? ""}\n${text}`) });
  if (failed) return end({ detail: text ? capText(text) : undefined });
  if (name === "Read")
    return end(Number.isSafeInteger(structured?.file?.numLines) && structured.file.numLines >= 0 ? { summary: `${structured.file.numLines} lines` } : {});
  if (name === "Grep" && Number.isSafeInteger(structured?.numMatches) && structured.numMatches >= 0)
    return end({ detail: text ? capText(text) : undefined, summary: `${structured.numMatches} matches` });
  const designTool = /^mcp__milagre__(design_show|design_apply|artifact_show|html_render)$/.exec(name)?.[1];
  if (designTool) {
    const artifact = artifactRef(text);
    return end({ artifact, title: artifact ? artifactTitle(artifact.title, designTool) : undefined });
  }
  if (name === "mcp__milagre__artifact_resolve_comment" || name === "mcp__milagre__browser_resolve_comment") return end({ detail: input.note });
  if (name === "mcp__milagre__heartbeat_create") {
    const { routine, detail } = routineRef(text);
    if (routine) return end({ routine, detail: detail ? capText(detail) : undefined });
  }
  if (CLAUDE_EDIT_TOOLS.has(name) || name === "Write") return end({ detail: patchDiff(structured) ?? claudeEditDiff(name, input) });
  if (CLAUDE_AGENT_TOOLS.has(name) && structured?.status === "async_launched") return end({ title: `Started an agent: ${input.description || "a subtask"}` });
  if (CLAUDE_AGENT_TOOLS.has(name) && Array.isArray(structured?.content)) return end({ detail: capText(blocksText(structured.content)) || undefined });
  if (name === "TodoWrite" && Array.isArray(input.todos))
    return end({ detail: input.todos.map((todo) => `${TODO_MARKS[todo.status] ?? "[ ]"} ${todo.content}`).join("\n") });
  return end({ detail: text ? capText(text) : undefined });
}

// --- Codex ---

// A command Codex recognised as one read, search or listing shows as that; anything else is a shell step.
function commandAction(item) {
  const actions = item.commandActions ?? [];
  return actions.length === 1 && actions[0]?.type !== "unknown" ? actions[0] : null;
}

function changeTitle(changes) {
  if (changes.length !== 1) return changes.length ? `Edited ${changes.length} files` : "Edited files";
  const type = changes[0].kind?.type;
  return `${type === "add" ? "Created" : type === "delete" ? "Deleted" : "Edited"} ${fileName(changes[0].path)}`;
}

function webSearchTitle(item) {
  const action = item.action ?? {};
  if (action.type === "openPage" && action.url) return `Opened ${code(action.url)}`;
  if (action.type === "findInPage" && action.url) return `Searched ${code(action.url)}${action.pattern ? ` for ${code(action.pattern)}` : ""}`;
  const query = item.query || action.query || action.queries?.[0];
  return query ? `Searched the web for ${code(query)}` : "Searched the web";
}

function webResults(results) {
  if (!Array.isArray(results)) return undefined;
  const lines = results.map((result) => [result?.title, result?.url].filter((part) => typeof part === "string" && part).join("\n")).filter(Boolean);
  return lines.length ? capText(lines.join("\n\n")) : undefined;
}

// item/started item -> step, or null for items that aren't tool calls (messages, reasoning, plans…).
function codexStep(item) {
  const metadata = item.type === "mcpToolCall" || item.type === "dynamicToolCall" ? toolMetadata(item.server, item.tool, item.arguments) : {};
  const step = (kind, title, detail, file) => compact({ id: String(item.id), kind, title, detail, file: filePath(file), ...metadata });
  switch (item.type) {
    case "commandExecution": {
      const command = unwrapShell(String(item.command ?? ""));
      const action = commandAction(item);
      const detail = capOutput(`$ ${command}\n`);
      if (action?.type === "read") return step("read", `Read ${code(action.name || path.basename(String(action.path ?? command)))}`, detail, action.path);
      if (action?.type === "search")
        return step(
          "search",
          action.query ? `Searched for ${code(action.query)}${action.path ? ` in ${code(action.path)}` : ""}` : `Searched ${code(action.path || command)}`,
          detail,
        );
      if (action?.type === "listFiles") return step("search", action.path ? `Listed files in ${code(action.path)}` : "Listed files", detail);
      return step("shell", `Ran ${code(command)}`, detail);
    }
    case "fileChange":
      return step("edit", changeTitle(item.changes ?? []), undefined, item.changes?.length === 1 ? item.changes[0].path : undefined);
    case "mcpToolCall":
      if (isArtifactTool(item.server, item.tool)) return artifactStep(step, item.arguments?.title, item.tool);
      if (isResolveTool(item.server, item.tool)) return step("other", resolvedTitle(item.tool), item.arguments?.note);
      return step("other", routineTitle(item.server, item.tool, item.arguments) ?? `Used ${code(item.tool)} from ${item.server}`);
    case "dynamicToolCall":
      return step("other", `Used ${code(item.tool)}`);
    case "webSearch":
      return step("search", webSearchTitle(item));
    case "imageView":
      return step("image", `Viewed ${fileName(item.path)}`, undefined, item.path);
    case "imageGeneration":
      return step("image", "Generating an image");
    // Codex summarizes the conversation when the context window fills, before or during a turn.
    case "contextCompaction":
      return step("other", "Compacting context");
    default:
      return null;
  }
}

// item/completed item -> the end of its step.
function codexStepResult(item) {
  const id = String(item.id);
  switch (item.type) {
    case "commandExecution": {
      const failed = item.status !== "completed" || (item.exitCode ?? 0) !== 0;
      const status = failed ? "failed" : "done";
      if (!failed && commandAction(item)?.type === "read") return { id, status };
      const output = item.status === "declined" ? "Declined." : (item.aggregatedOutput ?? "");
      return { id, status, detail: capOutput(`$ ${unwrapShell(String(item.command ?? ""))}\n${output}`) };
    }
    case "fileChange": {
      const changes = item.changes ?? [];
      return compact({
        id,
        status: item.status === "completed" ? "done" : "failed",
        title: changeTitle(changes),
        detail: changes.length ? codexChangesDiff(changes) : undefined,
      });
    }
    case "mcpToolCall": {
      const done = item.status === "completed" && !item.error;
      const text = blocksText(item.result?.content);
      if (done && isArtifactTool(item.server, item.tool)) {
        const artifact = artifactRef(text);
        return compact({ id, status: "done", artifact, title: artifact ? artifactTitle(artifact.title, item.tool) : undefined });
      }
      if (done && isResolveTool(item.server, item.tool)) return compact({ id, status: "done", detail: item.arguments?.note });
      if (done && item.server === "milagre" && item.tool === "heartbeat_create") {
        const { routine, detail } = routineRef(text);
        if (routine) return compact({ id, status: "done", routine, detail: detail ? capText(detail) : undefined });
      }
      return compact({
        id,
        status: done ? "done" : "failed",
        detail: capText(item.error?.message ?? text) || undefined,
      });
    }
    case "dynamicToolCall": {
      const text = (item.contentItems ?? [])
        .map((content) => (typeof content?.text === "string" ? content.text : ""))
        .filter(Boolean)
        .join("\n");
      return compact({ id, status: item.status === "completed" && item.success !== false ? "done" : "failed", detail: text ? capText(text) : undefined });
    }
    case "webSearch":
      return compact({ id, status: "done", title: webSearchTitle(item), detail: webResults(item.results) });
    case "imageView":
      return compact({ id, status: item.status === "failed" ? "failed" : "done", file: filePath(item.path) });
    case "imageGeneration": {
      // Codex reports "completed", or "failed" with a failure such as a used-up limit; result is the image as base64.
      const failed = item.status === "failed" || Boolean(item.failure) || (!item.savedPath && !item.result);
      const note = item.failure?.type === "usageLimitExceeded" ? "image limit reached" : undefined;
      return compact({
        id,
        status: failed ? "failed" : "done",
        title: failed ? "Couldn't generate an image" : "Generated an image",
        note,
        detail: item.revisedPrompt ? capText(item.revisedPrompt) : undefined,
        file: filePath(item.savedPath),
      });
    }
    case "contextCompaction":
      return { id, status: "done", title: "Compacted context" };
    default:
      return { id, status: item.status === "failed" ? "failed" : "done" };
  }
}

module.exports = {
  MAX_OUTPUT,
  capOutput,
  code,
  formatDuration,
  claudeStep,
  claudeStepResult,
  codexStep,
  codexStepResult,
  thinkingEnd,
  thinkingStep,
  routineRef,
};
