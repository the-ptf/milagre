#!/usr/bin/env node
// Pure Node ClaudeSession traces. No real SDK, process, credentials, profile or network.
const fs = require("node:fs");
const path = require("node:path");
const { ClaudeSession } = require("../../../packages/core/src/agents/claude-provider.cjs");
const init = { type: "system", subtype: "init", session_id: "session-1" };
const text = (piece) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
const result = { type: "result", subtype: "success", num_turns: 1, result: "done" };
const failure = (error) => ({ type: "result", subtype: "error_during_execution", errors: [error] });
const login = { type: "assistant", error: "authentication_failed", message: { content: [] } };
const suggestion = { type: "prompt_suggestion", session_id: "session-1", suggestion: "Run tests" };
const cases = [
  { name: "reply-and-suggestion", messages: [init, text("hello"), result, suggestion, suggestion] },
  { name: "implicit-turn", rustCorrections: ["implicit-text-owner"], messages: [init, text("first"), result, init, text("next"), result] },
  { name: "notification-only", messages: [init, result, init, { ...result, num_turns: 0, result: "" }] },
  { name: "new-session-login", messages: [init, login, failure("not logged in")] },
  { name: "resumed-session-login", resumeId: "session-1", messages: [init, login, failure("not logged in")] },
  { name: "missing-resume", resumeId: "session-1", messages: [failure("No conversation found")] },
  { name: "ordinary-error-keeps-resume", resumeId: "session-1", messages: [init, failure("Request was aborted.")] },
  { name: "disabled-suggestions", promptSuggestions: false, messages: [init, result, suggestion] },
];

(async () => {
  const output = [];
  for (const spec of cases) {
    const events = [];
    let position = 0;
    let finished;
    const delivered = new Promise((resolve) => {
      finished = resolve;
    });
    const session = new ClaudeSession({
      cwd: "/unused",
      command: "/fake/claude",
      resumeId: spec.resumeId,
      defaultConfigDir: "/nonexistent-milagre-conformance",
      env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: String(spec.promptSuggestions !== false) },
      emit: (event) => events.push(JSON.parse(JSON.stringify(event))),
      loadSdk: async () => ({
        query: ({ prompt }) => {
          const first = prompt[Symbol.asyncIterator]().next();
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              await first;
              // Allow beginTurn's event and promise continuation to settle first.
              await new Promise(setImmediate);
              if (position < spec.messages.length) return { value: spec.messages[position++], done: false };
              finished();
              return new Promise(() => {});
            },
            async return() {
              finished();
              return { done: true };
            },
            async setMaxThinkingTokens() {},
          };
        },
      }),
    });
    await session.startTurn({ prompt: "hello", model: "sonnet", permissionMode: "ask" });
    await delivered;
    const ids = new Map();
    for (const event of events) if (event.type === "turn-started") ids.set(event.turnId, `turn-${ids.size + 1}`);
    const normalized = JSON.parse(JSON.stringify(events, (_key, value) => ids.get(value) ?? value));
    output.push({ ...spec, events: normalized });
    await session.close();
  }
  const file = path.join(__dirname, "../tests/fixtures/conformance/claude-session.json");
  fs.writeFileSync(file, JSON.stringify({ generatedBy: "scripts/generate-session.cjs", cases: output }, null, 2) + "\n");
  console.log(`wrote ${output.length} session traces`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
