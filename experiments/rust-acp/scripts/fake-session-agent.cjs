// Lifecycle fault injector. No filesystem, vendor SDK, network, account or profile access.
const { createInterface } = require("node:readline");
const scenario = process.env.FAKE_SCENARIO;
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const result = (id, value) => send({ id, result: value });
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const text = (sessionId, body) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } });
const permission = (sessionId, id = "permission") =>
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "t", kind: "execute", rawInput: { command: "fixture-only" } },
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
      ],
    },
  });
let prompt;
let native;
let turns = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  switch (method) {
    case "initialize":
      if (scenario === "hang-init") return;
      return result(id, {
        protocolVersion: scenario === "bad-version" ? 2 : 1,
        agentCapabilities: { loadSession: scenario !== "no-load", sessionCapabilities: {} },
      });
    case "session/load":
      if (scenario === "hang-load" || scenario === "stop-during-load") {
        text(params.sessionId, "old replay");
        return;
      }
      text(params.sessionId, "old replay");
      return result(id, { sessionId: params.sessionId });
    case "session/new":
      native = "fault-session";
      return result(id, scenario === "missing-id" ? {} : { sessionId: native });
    case "session/prompt":
      prompt = id;
      native = params.sessionId;
      turns++;
      if (scenario === "error-after-text") {
        text(native, "before error");
        send({ id, error: { code: -32000, message: "fixture error" } });
        return;
      }
      if (scenario === "exit-after-text") {
        text(native, "before exit");
        process.stdout.write("", () => process.exit(1));
        return;
      }
      if (scenario === "reuse-permission") return permission(native);
      if (scenario === "blocked-answer") {
        send({
          id: "permission",
          method: "session/request_permission",
          params: { sessionId: native, toolCall: { toolCallId: "t" }, options: [{ kind: "allow_once", optionId: "x".repeat(200000) }] },
        });
        process.stdin.pause();
        setInterval(() => {}, 1000);
        return;
      }
      if (scenario === "metadata-flood") {
        update(native, { sessionUpdate: "config_option_update", configOptions: [{ id: "model", options: [{ value: "m", description: "x".repeat(50000) }] }] });
        return;
      }
      if (scenario === "permission-timeout") return permission(native);
      if (scenario === "permission-flood") {
        for (let i = 0; i < 20; i++) permission(native, `p-${i}`);
        return;
      }
      if (scenario === "state-flood") {
        for (let i = 0; i < 30; i++)
          update(native, {
            sessionUpdate: "tool_call",
            toolCallId: `call-${i}`,
            status: "pending",
            content: [{ type: "diff", path: `/p-${i}`, newText: "data" }],
          });
        return;
      }
      if (scenario === "thinking-flood") {
        for (let i = 0; i < 100; i++) update(native, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x".repeat(1024) } });
        return;
      }
      if (scenario === "wrong-session") {
        text("wrong", "wrong text");
        text(17, "malformed session id");
        permission("wrong");
      }
      if (scenario === "stale-permission") {
        permission(native);
        result(id, { stopReason: "end_turn" });
        return;
      }
      if (scenario === "multi-turn") {
        update(native, {
          sessionUpdate: "tool_call",
          toolCallId: `c-${turns}`,
          status: "pending",
          content: [{ type: "diff", path: `/file-${turns}`, newText: "x" }],
        });
        update(native, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      }
      text(native, "live");
      result(id, { stopReason: "end_turn" });
      if (scenario === "permission-after-end" || scenario === "reply-then-permission") permission(native);
      if (scenario === "late-update") text(native, "late after response");
      if (scenario === "exit-after-result") setTimeout(() => process.exit(1), 10);
      return;
    case "session/cancel":
      if (prompt) result(prompt, { stopReason: "cancelled" });
      prompt = null;
      return;
    case "fake/finish":
      if (prompt) result(prompt, { stopReason: "end_turn" });
      prompt = null;
      return result(id, {});
    default:
      if (!method && scenario === "reuse-permission" && prompt) {
        text(native, "answered");
        result(prompt, { stopReason: "end_turn" });
        prompt = null;
      }
      if (method) send({ id, error: { code: -32601, message: "unsupported fake method" } });
  }
});
