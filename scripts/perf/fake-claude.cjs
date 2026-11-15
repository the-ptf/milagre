// A stand-in for `claude` in scripts/perf/run.cjs: it speaks enough of Claude Code's stream-json protocol for a turn,
// with no account, network or tokens, so every run streams the same text at the same pace. A prompt holding
// `perf-run:mix` or `perf-run:code` gets a long reply; anything else (a generated title, a model probe) gets one line.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const SECONDS = Number(process.env.PERF_SECONDS ?? 45);
const INTERVAL_MS = Number(process.env.PERF_INTERVAL_MS ?? 40);
const CHARS = Number(process.env.PERF_CHARS ?? 16);
const MARKS = process.env.PERF_MARK_DIR;
const MODEL = "claude-perf";
const session = randomUUID();

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const event = (body) => send({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: body });

function section(n) {
  return [
    `## Section ${n}\n`,
    `Paragraph ${n} is ordinary prose, long enough to wrap at any window width, so each streamed batch lays out text the`,
    "way a real reply does. It mentions `inline code` and a [link](https://example.com) to reach the inline renderers.\n",
    `- First item of list ${n}`,
    "- Second item, a little longer than the first one",
    "- Third item\n",
    "```ts",
    `export function step${n}(rows: Row[], width: number): number {`,
    "  let changed = 0;",
    "  for (const row of rows) if (row.version !== row.measured) changed += row.measure(width);",
    "  return changed;",
    "}",
    "```\n",
    "| Phase | Before | After |",
    "|---|---:|---:|",
    `| layout | ${20 + (n % 7)}% | ${3 + (n % 3)}% |\n\n`,
  ].join("\n");
}

function codeLine(n) {
  return `  const value${n} = rows.filter((row) => row.id !== ${n}).map((row) => ({ ...row, seen: ${n % 2 === 0} }));\n`;
}

/** The reply, sized to stream for SECONDS at the configured pace. */
function replyText(kind, turn) {
  const size = Math.floor((SECONDS * 1000) / INTERVAL_MS) * CHARS;
  let text = `perf-reply-${turn}\n\n`;
  if (kind === "code") text += "```ts\nexport function generated() {\n";
  for (let n = 1; text.length < size; n++) text += kind === "code" ? codeLine(n) : section(n);
  return text.slice(0, size);
}

const mark = (name) => {
  if (MARKS) fs.writeFileSync(path.join(MARKS, name), String(Date.now()));
};

async function reply(text, turn) {
  if (turn) mark(`turn-${turn}-start`);
  event({ type: "message_start", message: { model: MODEL, role: "assistant" } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const started = Date.now();
  for (let at = 0, tick = 0; at < text.length; at += CHARS, tick++) {
    // Paced against the start, so a slow write doesn't stretch the stream.
    const wait = started + tick * INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(at, at + CHARS) } });
  }
  const usage = { input_tokens: 1000, output_tokens: Math.ceil(text.length / 4) };
  event({ type: "content_block_stop", index: 0 });
  send({
    type: "assistant",
    session_id: session,
    parent_tool_use_id: null,
    message: { model: MODEL, role: "assistant", content: [{ type: "text", text }], usage },
  });
  event({ type: "message_stop" });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    result: text,
    duration_ms: Date.now() - started,
    usage,
    modelUsage: { [MODEL]: { contextWindow: 200000 } },
  });
  if (turn) mark(`turn-${turn}-end`);
}

/** A turn that runs one Bash tool for SECONDS: what a window shows while an agent works (step row, shimmer, timers). */
async function toolTurn(turn) {
  mark(`turn-${turn}-start`);
  const started = Date.now();
  const id = `toolu_perf_${turn}`;
  const input = { command: "sleep 60", description: "Wait for the build" };
  event({ type: "message_start", message: { model: MODEL, role: "assistant" } });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `perf-reply-${turn}\n\nRunning the build.` } });
  event({ type: "content_block_stop", index: 0 });
  event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: "Bash", input: {} } });
  event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  event({ type: "content_block_stop", index: 1 });
  const usage = { input_tokens: 1000, output_tokens: 40 };
  send({
    type: "assistant",
    session_id: session,
    parent_tool_use_id: null,
    message: {
      model: MODEL,
      role: "assistant",
      content: [
        { type: "text", text: `perf-reply-${turn}\n\nRunning the build.` },
        { type: "tool_use", id, name: "Bash", input },
      ],
      usage,
    },
  });
  event({ type: "message_stop" });
  await delay(SECONDS * 1000);
  send({
    type: "user",
    session_id: session,
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  });
  await reply("The build finished.", null);
  mark(`turn-${turn}-end`);
  void started;
}

function answer(frame) {
  const subtype = frame.request?.subtype;
  const response = subtype === "list_models" ? { models: [{ value: MODEL, displayName: "Perf", description: "Scripted replies" }] } : {};
  send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response } });
  if (subtype === "initialize") send({ type: "system", subtype: "init", session_id: session, model: MODEL, tools: [], mcp_servers: [] });
}

async function main() {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("2.1.999 (Claude Code perf stub)");
    return;
  }
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "control_request") answer(frame);
    if (frame.type !== "user") continue;
    const asked = /perf-run:(mix|code|tool):(\d+)/.exec(JSON.stringify(frame));
    if (asked?.[1] === "tool") await toolTurn(asked[2]);
    else await (asked ? reply(replyText(asked[1], asked[2]), asked[2]) : reply("Perf stub.", null));
  }
}

void main();
