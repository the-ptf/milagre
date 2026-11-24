const path = require("node:path");
const { claudeStep, claudeStepResult, code, thinkingEnd, thinkingStep } = require("./steps.cjs");

const now = (state) => (state.now ?? Date.now)();
const str = (value) => (typeof value === "string" ? value : "");

const absolute = (cwd, file) => (typeof file === "string" && file ? (path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file)) : undefined);

// Pi's built-in tools, as the Claude Code tools Milagre already knows how to show and ask about.
function asClaudeTool(name, input = {}, cwd) {
  const file = absolute(cwd, input.path);
  switch (name) {
    case "bash":
      return { name: "Bash", input: { command: str(input.command) } };
    case "read":
      return { name: "Read", input: { file_path: file } };
    case "write":
      return { name: "Write", input: { file_path: file, content: str(input.content) } };
    case "edit": {
      const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
      return {
        name: "MultiEdit",
        input: { file_path: file, edits: edits.map((edit) => ({ old_string: str(edit?.oldText), new_string: str(edit?.newText) })) },
      };
    }
    case "grep":
      return { name: "Grep", input: { pattern: str(input.pattern), path: input.path } };
    case "find":
      return { name: "Glob", input: { pattern: str(input.pattern) } };
    default:
      return { name, input };
  }
}

function piStep(id, name, input, cwd) {
  if (name === "ls") return { id: String(id), kind: "read", title: `Listed ${code(input?.path || ".")}` };
  if (name === "tool_search") return { id: String(id), kind: "search", title: `Searched tools for ${code(input?.query ?? "")}` };
  const tool = asClaudeTool(name, input, cwd);
  return claudeStep(id, tool.name, tool.input);
}

function piStepResult(id, name, input, result, isError, cwd) {
  const tool = asClaudeTool(name, input, cwd);
  const block = { is_error: Boolean(isError), content: Array.isArray(result?.content) ? result.content : [] };
  return claudeStepResult({ id, name: tool.name, input: tool.input }, block, null);
}

function closeThinking(state) {
  const thinking = state.thinking;
  if (!thinking) return [];
  state.thinking = null;
  return [{ type: "step-completed", ...thinkingEnd(thinking.id, now(state) - thinking.startedAt, thinking.text) }];
}

function textDelta(state, value) {
  const events = [];
  if (state.hasText && state.textBreak) events.push({ type: "text-delta", messageId: state.turnId, text: "\n\n", startsMessage: true });
  state.textBreak = false;
  state.hasText = true;
  events.push({ type: "text-delta", messageId: state.turnId, text: value });
  return events;
}

function assistantUpdate(update, state) {
  switch (update?.type) {
    case "thinking_start": {
      state.thinkingCount = (state.thinkingCount ?? 0) + 1;
      state.thinking = { id: `thinking-${state.thinkingCount}`, text: "", startedAt: now(state) };
      state.textBreak = true;
      return [{ type: "step-started", step: thinkingStep(state.thinking.id) }];
    }
    case "thinking_delta": {
      const value = str(update.delta);
      if (!state.thinking || !value) return [];
      state.thinking.text += value;
      return [{ type: "step-output", id: state.thinking.id, text: value }];
    }
    case "thinking_end":
      if (state.thinking && typeof update.content === "string") state.thinking.text = update.content;
      return closeThinking(state);
    case "text_delta": {
      const value = str(update.delta);
      return value ? [...closeThinking(state), ...textDelta(state, value)] : [];
    }
    default:
      return [];
  }
}

/** Milagre events for one Pi session event. `state` carries the turn: its id, open thinking step and tool calls. */
function mapPiEvent(event, state) {
  switch (event?.type) {
    case "message_update":
      return assistantUpdate(event.assistantMessageEvent, state);
    case "tool_execution_start": {
      const id = String(event.toolCallId ?? "");
      if (!id) return [];
      state.calls.set(id, { name: event.toolName, input: event.args ?? {} });
      state.textBreak = true;
      return [...closeThinking(state), { type: "step-started", step: piStep(id, event.toolName, event.args ?? {}, state.cwd) }];
    }
    case "tool_execution_update": {
      const id = String(event.toolCallId ?? "");
      const call = state.calls.get(id);
      if (!call || call.name !== "bash") return [];
      const text = (event.partialResult?.content ?? []).map((block) => (block?.type === "text" ? str(block.text) : "")).join("");
      const seen = state.outputs.get(id) ?? "";
      if (!text.startsWith(seen) || text.length === seen.length) return [];
      state.outputs.set(id, text);
      return [{ type: "step-output", id, text: text.slice(seen.length) }];
    }
    case "tool_execution_end": {
      const id = String(event.toolCallId ?? "");
      const call = state.calls.get(id) ?? { name: event.toolName, input: event.args ?? {} };
      state.calls.delete(id);
      state.outputs.delete(id);
      const end = piStepResult(id, call.name, call.input, event.result, event.isError, state.cwd);
      return [{ type: "step-completed", ...end, ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}) }];
    }
    case "compaction_start":
      return [{ type: "context-compacting" }];
    case "compaction_end":
      return event.result
        ? [
            {
              type: "context-compacted",
              trigger: event.reason === "manual" ? "manual" : "auto",
              ...(Number.isFinite(event.result.tokensBefore) ? { before: event.result.tokensBefore } : {}),
              ...(Number.isFinite(event.result.estimatedTokensAfter) ? { after: event.result.estimatedTokensAfter } : {}),
            },
          ]
        : [];
    default:
      return [];
  }
}

// How the local model ran this turn. Pi reports tokens per model call but no timings, so they are measured
// here: prefill is from a call's start to its first streamed event, generation from there to the call's end.
function createTurnMetrics(clock = Date.now) {
  const startedAt = clock();
  const totals = { calls: 0, prefillMs: 0, decodeMs: 0, prefillTokens: 0, outputTokens: 0, inputTokens: 0 };
  let firstTokenAt = null;
  let callStartedAt = startedAt;
  let messageStartedAt = null;
  return {
    event(event) {
      const at = clock();
      if (event?.type === "turn_start") callStartedAt = at;
      if (event?.message?.role !== "assistant") return;
      if (event.type === "message_start") {
        firstTokenAt ??= at;
        messageStartedAt = at;
        totals.prefillMs += at - callStartedAt;
      } else if (event.type === "message_end" && messageStartedAt !== null) {
        const usage = event.message.usage ?? {};
        totals.calls += 1;
        totals.decodeMs += at - messageStartedAt;
        totals.prefillTokens += Number(usage.input) || 0;
        totals.outputTokens += Number(usage.output) || 0;
        totals.inputTokens = (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0);
        messageStartedAt = null;
      }
    },
    result() {
      if (!totals.calls) return null;
      const rate = (tokens, ms) => (ms >= 100 && tokens > 0 ? Math.round((tokens / ms) * 10_000) / 10 : undefined);
      const metrics = {
        ttftMs: firstTokenAt === null ? undefined : firstTokenAt - startedAt,
        outputTps: rate(totals.outputTokens, totals.decodeMs),
        prefillTps: rate(totals.prefillTokens, totals.prefillMs),
        inputTokens: totals.inputTokens || undefined,
        outputTokens: totals.outputTokens || undefined,
        calls: totals.calls,
        durationMs: clock() - startedAt,
      };
      return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined));
    },
  };
}

/** The assistant's error, when the turn's last message ended with one (Ollama down, model missing, context full). */
function assistantError(messages) {
  const last = (Array.isArray(messages) ? messages : []).findLast((message) => message?.role === "assistant");
  return last?.stopReason === "error" ? str(last.errorMessage) || "The model stopped with an error." : null;
}

module.exports = { asClaudeTool, assistantError, closeThinking, createTurnMetrics, mapPiEvent };
