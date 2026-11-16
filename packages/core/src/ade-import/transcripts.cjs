const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { claudeStep, claudeStepResult, codexStep, codexStepResult, thinkingEnd, thinkingStep } = require("../agents/steps.cjs");

const SYSTEM_TEXT =
  /^\s*<(system-reminder|task-notification|local-command-[a-z]+|command-(name|message|args)|user-prompt-submit-hook|handoff_brief|milagre_note)\b/;
const HIDDEN_TOOLS = new Set(["AskUserQuestion"]);

async function* jsonLines(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

const isoMs = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block.type === "text" || block.type === "input_text" || block.type === "output_text" || block.type === "Text"))
    .map((block) => block.text ?? "")
    .join("\n");
}

const userText = (text) => (SYSTEM_TEXT.test(text) ? "" : text.trim());

class TranscriptBuilder {
  constructor() {
    this.messages = [];
    this.reply = null;
  }

  user(body, at) {
    this.close();
    if (body) this.messages.push({ role: "user", body, context: null, ...(at ? { createdAt: at } : {}) });
  }

  current(model) {
    this.reply ??= { text: "", steps: new Map(), model };
    if (model && !this.reply.model) this.reply.model = model;
    return this.reply;
  }

  text(value, model) {
    if (!value) return;
    const reply = this.current(model);
    reply.text += reply.text && !reply.text.endsWith("\n") ? `\n\n${value}` : value;
  }

  start(step, model) {
    const reply = this.current(model);
    if (!reply.steps.has(step.id)) reply.steps.set(step.id, { ...step, status: "running", offset: reply.text.length });
  }

  finish(result) {
    const step = this.reply?.steps.get(result.id);
    if (step) this.reply.steps.set(result.id, { ...step, ...result });
  }

  close() {
    const reply = this.reply;
    this.reply = null;
    if (!reply || (!reply.text.trim() && !reply.steps.size)) return;
    const lead = reply.text.length - reply.text.trimStart().length;
    const length = reply.text.trim().length;
    const steps = [...reply.steps.values()].map((step) => ({
      ...step,
      status: step.status === "running" ? "done" : step.status,
      offset: Math.min(Math.max(step.offset - lead, 0), length),
    }));
    this.messages.push({
      role: "assistant",
      body: reply.text.trim(),
      context: null,
      outcome: "completed",
      ...(reply.model ? { model: reply.model } : {}),
      ...(steps.length ? { steps } : {}),
    });
  }

  done() {
    this.close();
    return this.messages;
  }
}

async function claudeTranscript(file) {
  const out = new TranscriptBuilder();
  const calls = new Map();
  let thinking = 0;
  for await (const line of jsonLines(file)) {
    if ((line.type !== "user" && line.type !== "assistant") || line.isSidechain || line.isMeta || line.isCompactSummary) continue;
    const content = line.message?.content;
    if (line.type === "user") {
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks.filter((item) => item?.type === "tool_result")) {
        const call = calls.get(block.tool_use_id);
        if (call) out.finish(claudeStepResult(call, block, blocks.length === 1 ? line.toolUseResult : undefined));
      }
      if (typeof content === "string" || blocks.some((item) => item?.type === "text")) {
        const body = userText(textOf(typeof content === "string" ? content : blocks.filter((item) => !SYSTEM_TEXT.test(item?.text ?? ""))));
        if (body) out.user(body, isoMs(line.timestamp));
      }
      continue;
    }
    const model = line.message?.model && line.message.model !== "<synthetic>" ? line.message.model : undefined;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "text") out.text(block.text, model);
      else if (block?.type === "thinking" && block.thinking) {
        const id = `thinking-${++thinking}`;
        out.start(thinkingStep(id), model);
        out.finish(thinkingEnd(id, undefined, block.thinking));
      } else if (block?.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
        calls.set(block.id, block);
        out.start(claudeStep(block.id, block.name, block.input), model);
      }
    }
  }
  return out.done();
}

const CODEX_ITEMS = {
  CommandExecution: (item) => ({
    type: "commandExecution",
    id: item.id,
    command: Array.isArray(item.command) ? item.command.at(-1) : item.command,
    commandActions: item.parsed_cmd,
    status: item.status,
    exitCode: item.exit_code ?? item.exitCode,
    aggregatedOutput: item.aggregated_output ?? item.aggregatedOutput,
  }),
  FileChange: (item) => ({
    type: "fileChange",
    id: item.id,
    status: item.status,
    changes: Object.entries(item.changes ?? {}).map(([file, change]) => ({ path: file, kind: { type: change?.type }, diff: change?.unified_diff ?? "" })),
  }),
  McpToolCall: (item) => ({
    type: "mcpToolCall",
    id: item.id,
    server: item.server,
    tool: item.tool,
    arguments: item.arguments,
    status: item.status,
    result: item.result,
    error: item.error,
  }),
};

function codexItemStep(out, item, model) {
  const toAppItem = CODEX_ITEMS[item.type];
  if (!toAppItem) return;
  const appItem = toAppItem(item);
  try {
    out.start(codexStep(appItem), model);
    out.finish(codexStepResult(appItem));
  } catch {}
}

function codexResponseStep(out, payload, outputs, model) {
  if (payload.type !== "function_call" && payload.type !== "custom_tool_call" && payload.type !== "local_shell_call") return;
  const id = payload.call_id ?? payload.id;
  let input = payload.input ?? payload.arguments ?? "";
  try {
    if (typeof input === "string" && input.startsWith("{")) input = JSON.parse(input);
  } catch {}
  const command = typeof input === "object" ? (input.cmd ?? input.command ?? payload.action?.command) : undefined;
  const output = textOf(outputs.get(id)) || (typeof outputs.get(id) === "string" ? outputs.get(id) : "");
  const appItem =
    command !== undefined
      ? {
          type: "commandExecution",
          id,
          command: Array.isArray(command) ? command.at(-1) : String(command),
          status: "completed",
          exitCode: 0,
          aggregatedOutput: output,
        }
      : payload.name === "apply_patch"
        ? { type: "fileChange", id, status: "completed", changes: [] }
        : { type: "dynamicToolCall", id, tool: payload.name, arguments: input, status: "completed" };
  try {
    out.start(codexStep(appItem), model);
    out.finish(
      appItem.type === "fileChange"
        ? { id, status: "done", title: "Edited files", detail: typeof input === "string" ? input.slice(0, 20000) : undefined }
        : codexStepResult(appItem),
    );
  } catch {}
}

async function codexTranscript(file) {
  const lines = [];
  for await (const line of jsonLines(file)) lines.push(line);
  const items = lines.some((line) => line.type === "event_msg" && line.payload?.type === "item_completed");
  const outputs = new Map();
  if (!items)
    for (const line of lines) {
      const payload = line.payload ?? {};
      if (line.type === "response_item" && String(payload.type ?? "").endsWith("_output")) outputs.set(payload.call_id, payload.output);
    }
  const out = new TranscriptBuilder();
  let model;
  let reasoning = 0;
  for (const line of lines) {
    const payload = line.payload ?? {};
    if (line.type === "turn_context" && payload.model) model = payload.model;
    if (line.type === "event_msg" && payload.type === "thread_settings_applied" && payload.thread_settings?.model) model = payload.thread_settings.model;
    if (items) {
      if (line.type !== "event_msg" || payload.type !== "item_completed") continue;
      const item = payload.item ?? {};
      if (item.type === "UserMessage") out.user(userText(textOf(item.content)), isoMs(line.timestamp));
      else if (item.type === "AgentMessage") out.text(textOf(item.content), model);
      else if (item.type === "Reasoning" && item.summary_text?.length) {
        const id = `thinking-${++reasoning}`;
        out.start(thinkingStep(id), model);
        out.finish(thinkingEnd(id, undefined, item.summary_text.join("\n")));
      } else codexItemStep(out, item, model);
      continue;
    }
    if (line.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") out.user(userText(textOf(payload.content)), isoMs(line.timestamp));
    else if (payload.type === "message" && payload.role === "assistant") out.text(textOf(payload.content), model);
    else codexResponseStep(out, payload, outputs, model);
  }
  return out.done();
}

function claudeHomes(env, home) {
  const homes = [env.CLAUDE_CONFIG_DIR, path.join(home, ".claude")].filter(Boolean);
  return [...new Set(homes)];
}

function codexHomes(env, home) {
  return [...new Set([env.CODEX_HOME, path.join(home, ".codex")].filter(Boolean))];
}

function findClaudeTranscript(sessionId, { env = process.env, home } = {}) {
  if (!/^[\w-]+$/.test(String(sessionId))) return null;
  for (const root of claudeHomes(env, home)) {
    const projects = path.join(root, "projects");
    let folders = [];
    try {
      folders = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const folder of folders) {
      const file = path.join(projects, folder.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function findCodexTranscript(threadId, { env = process.env, home } = {}) {
  if (!/^[\w-]+$/.test(String(threadId))) return null;
  const suffix = `-${threadId}.jsonl`;
  for (const root of codexHomes(env, home)) {
    for (const base of [path.join(root, "sessions"), path.join(root, "archived_sessions")]) {
      const found = findFile(base, (name) => name.endsWith(suffix), 4);
      if (found) return found;
    }
  }
  return null;
}

function findFile(folder, matches, depth) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) if (entry.isFile() && matches(entry.name)) return path.join(folder, entry.name);
  if (depth <= 0) return null;
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const found = findFile(path.join(folder, entry.name), matches, depth - 1);
    if (found) return found;
  }
  return null;
}

async function readTranscript(provider, nativeId, options) {
  const file = provider === "claude" ? findClaudeTranscript(nativeId, options) : provider === "codex" ? findCodexTranscript(nativeId, options) : null;
  if (!file) return { file: null, messages: [] };
  return { file, messages: provider === "claude" ? await claudeTranscript(file) : await codexTranscript(file) };
}

module.exports = { claudeTranscript, codexTranscript, findClaudeTranscript, findCodexTranscript, readTranscript };
