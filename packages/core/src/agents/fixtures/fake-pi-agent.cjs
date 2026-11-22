// A stand-in for `pi --mode rpc`: answers Milagre's commands and plays FAKE_SCENARIO when prompted.
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || "chat";
if (args.includes("--session") && process.env.FAKE_MISSING_SESSION) {
  process.stderr.write("No session found\n");
  process.exit(1);
}

const sessionId = args.includes("--session") ? args[args.indexOf("--session") + 1] : "pi-session-1";
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, command, data) => send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
const update = (assistantMessageEvent) => send({ type: "message_update", usage: {}, assistantMessageEvent });
const settle = (aborted = false, messages = []) => {
  send({ type: "agent_end", messages, willRetry: false });
  send({ type: "agent_settled", aborted });
};
const waiting = new Map();
let streaming = false;
let autoCompaction = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ask(input) {
  const id = `ui-${waiting.size + 1}`;
  send({
    type: "extension_ui_request",
    id,
    method: "select",
    title: JSON.stringify({ type: "milagre:tool_call", toolCallId: "call-1", ...input }),
    options: ["allow", "deny"],
  });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function play() {
  streaming = true;
  send({ type: "agent_start" });
  if (scenario === "chat") {
    send({ type: "turn_start" });
    await wait(120);
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    update({ type: "thinking_start", contentIndex: 0 });
    update({ type: "thinking_delta", contentIndex: 0, delta: "Hmm" });
    update({ type: "thinking_end", contentIndex: 0, content: "Hmm, easy." });
    update({ type: "text_delta", contentIndex: 1, delta: "Hello\u2028world" });
    await wait(150);
    send({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 900, output: 30, cacheRead: 100 } } });
    settle();
  } else if (scenario === "tool") {
    const input = JSON.parse(process.env.FAKE_TOOL || '{"toolName":"bash","input":{"command":"ls"}}');
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: input.toolName, args: input.input });
    const answer = await ask(input);
    if (answer.value === "allow") {
      send({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: input.toolName,
        args: input.input,
        partialResult: { content: [{ type: "text", text: "a\n" }] },
      });
      send({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: input.toolName,
        result: { content: [{ type: "text", text: "a\nb\n" }] },
        isError: false,
      });
    } else {
      send({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: input.toolName,
        result: { content: [{ type: "text", text: answer.value }] },
        isError: true,
      });
    }
    update({ type: "text_delta", contentIndex: 0, delta: `answer:${answer.value}` });
    settle();
  } else if (scenario === "error") {
    settle(false, [{ role: "assistant", content: [], stopReason: "error", errorMessage: "model not found" }]);
  }
  if (scenario !== "hang") streaming = false;
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    const command = JSON.parse(line);
    if (command.type === "extension_ui_response") {
      waiting.get(command.id)?.(command);
      waiting.delete(command.id);
      continue;
    }
    const { id, type } = command;
    if (type === "get_state")
      respond(id, type, {
        sessionId,
        model: { provider: args[args.indexOf("--provider") + 1], id: args[args.indexOf("--model") + 1] },
        thinkingLevel: "off",
        isStreaming: streaming,
      });
    else if (type === "prompt") {
      respond(id, type, { disposition: "started" });
      void play();
    } else if (type === "steer") {
      respond(id, type, { disposition: "queued" });
      update({ type: "text_delta", contentIndex: 0, delta: `steered:${command.message}` });
    } else if (type === "abort") {
      streaming = false;
      settle(true);
      respond(id, type);
    } else if (type === "set_auto_compaction") {
      autoCompaction = command.enabled;
      respond(id, type);
    } else if (type === "compact") {
      // Reports the compaction only when Milagre switched automatic compaction on first, so a test can tell.
      if (autoCompaction) {
        send({ type: "compaction_start", reason: "manual" });
        send({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "s", tokensBefore: 50000, estimatedTokensAfter: 8000 },
          aborted: false,
          willRetry: false,
        });
      }
      respond(id, type, {});
    } else if (type === "get_session_stats")
      respond(id, type, { cost: Number(process.env.FAKE_COST) || 0, contextUsage: { tokens: 1200, contextWindow: 65536, percent: 1.8 } });
    else if (type === "set_model") respond(id, type, { id: command.modelId });
    else respond(id, type, type === "clear_queue" ? { steering: [], followUp: [] } : undefined);
  }
});
process.stdin.on("end", () => process.exit(0));
