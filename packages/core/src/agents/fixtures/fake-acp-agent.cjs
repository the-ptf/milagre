// Stand-in for an ACP agent (Antigravity's agy_acp_server) in tests: JSON-RPC 2.0 over stdio, shaped
// like what agy 1.3.0 sends. FAKE_SCENARIO picks how a prompt behaves:
//   reply (default)  two text chunks, end_turn
//   thinking         thought chunks, then text
//   command          a command runs (pending -> in_progress -> completed with output), then text
//   failing-command  a command that exits 2
//   permission       a command asks first; the reply text names the option picked ("cancelled" if none)
//   guarded          `git push origin HEAD` asks first and fails when refused, then `ls build` asks; the reply names both
//                    options picked
//   mcp-plan-tool    a Milagre plan tool call asks first; the reply text names the option picked
//   mcp-design-tool  as mcp-plan-tool, for a Milagre tool that still needs the user's say
//   edit             an edit asks with its diff, runs as another call, and the asking call fails "never executed"
//   question         an interaction_ request (a question); the reply text names the option picked
//   plan             a plan with three entries
//   json             a fenced JSON object naming the session's model, cwd and mcpServers (text generation)
//   json-permission  a command asks first; the JSON object names the option picked
//   slow             the prompt waits for session/cancel, then ends "cancelled"; fake/finish ends it "end_turn"
//   stubborn         the prompt never ends and session/cancel is ignored
//   stubborn-command as stubborn, with a command running in a process group of its own (fake/received names its pid)
//   crash            the agent logs an error and exits during the prompt
//   logged-out       session/new fails with -32000 Authentication required
//   prompt-login     session/prompt fails with -32000
//   subscription     session/new fails with SUBSCRIPTION_REQUIRED
//   reject-mcp       session/new and session/resume refuse a non-empty mcpServers
//   reject-extra-mcp session/new and session/resume refuse an mcpServers list with a server other than milagre
//   no-resume        no session/resume capability: session/load replays history first
//   sign-in-line     prints the sign-in URL on stdout and stderr at startup
// A session id "missing" can't be resumed or loaded. fake/received returns every message received.
const { createInterface } = require("node:readline");

const scenario = process.env.FAKE_SCENARIO || "reply";
// Kiro's shapes: "kiro" replies, "kiro-tools" asks for an edit and two commands like kiro-cli's v3 engine.
const kiro = scenario.startsWith("kiro");
const received = [];
let sessions = 0;
let model = kiro ? "auto" : "gemini-3.8-flash-high";
let mode = kiro ? "vibe" : "default";
// Kiro: models carry their credits and efforts, `effortLevel` follows the model at its default,
// and approvals are the `autopilot` option.
const KIRO_MODELS = [
  { value: "auto", name: "Auto", description: "Models chosen by task", _meta: { kiro: { rateMultiplier: 1, rateUnit: "Credit" } } },
  {
    value: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    description: "Claude Opus 5.5 model with 1M context window",
    _meta: { kiro: { rateMultiplier: 2, rateUnit: "Credit", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "medium" } },
  },
];
const kiroDefaultEffort = (value) => {
  const { _meta: meta } = KIRO_MODELS.find((item) => item.value === value) ?? {};
  return meta?.kiro.defaultEffortLevel ?? null;
};
let effortLevel = null;
let autopilot = "off";
let promptWaiter = null;
let waiting = null;
let nextServerId = 0;
let commandPid = null;
let sessionCwd = null;
let sessionMcp = null;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const text = (sessionId, value) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });

const kiroConfigOptions = () => [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode, options: ["vibe", "spec"].map((value) => ({ value, name: value })) },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: model, options: KIRO_MODELS },
  ...(effortLevel ? [{ id: "effortLevel", name: "Effort", type: "select", currentValue: effortLevel, options: [] }] : []),
  { id: "autopilot", name: "Autopilot", type: "select", currentValue: autopilot, options: ["on", "off"].map((value) => ({ value, name: value })) },
];
const configOptions = () => (kiro ? kiroConfigOptions() : antigravityConfigOptions());
const antigravityConfigOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", description: "gemini-3.8-flash-high" },
      // An id the catalog doesn't have: Flash at Low resolves to it only from what the session offers.
      { value: "flash-lite-agent", name: "Gemini 3.8 Flash (Low)", description: "flash-lite-agent" },
      { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", description: "gemini-pro-agent" },
    ],
  },
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: ["default", "auto_edit", "yolo"].map((value) => ({ value, name: value })),
  },
];
const sessionResult = (sessionId) => ({
  ...(sessionId ? { sessionId } : {}),
  modes: { currentModeId: mode, availableModes: [{ id: "default" }, { id: "auto_edit" }, { id: "yolo" }] },
  configOptions: configOptions(),
});

const OPTIONS = [
  { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

// A pending shell command call.
const commandCall = (toolCallId, line) => ({ toolCallId, title: line, kind: "execute", status: "pending", rawInput: { CommandLine: line, Cwd: "/w" } });

// Asks the client and resolves with its reply's result.
function ask(params) {
  const id = nextServerId++;
  send({ id, method: "session/request_permission", params });
  return new Promise((resolve) => {
    waiting = { id, resolve };
  });
}
const picked = (result) => (result?.outcome?.outcome === "selected" ? result.outcome.optionId : "cancelled");

async function runPrompt(id, sessionId) {
  const end = (stopReason = "end_turn") => send({ id, result: { stopReason } });
  switch (scenario) {
    case "thinking":
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Pondering" } });
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } });
      text(sessionId, "Done");
      return end();
    case "command":
    case "failing-command": {
      const exitCode = scenario === "command" ? 0 : 2;
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        title: "ls",
        kind: "execute",
        status: "pending",
        rawInput: { CommandLine: "ls", Cwd: "/w" },
      });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        kind: "execute",
        status: "in_progress",
        title: "ls",
        rawInput: { command_line: "ls", working_dir: "/w" },
      });
      update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 1048576 });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        status: "completed",
        rawOutput: { commandLine: "ls", exitCode, exit_code: exitCode, combinedOutput: "a.txt\r\nb.txt\r\n" },
      });
      text(sessionId, "Two files.");
      return end();
    }
    case "permission": {
      const call = { toolCallId: "cmd-1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { CommandLine: "rm -rf build", Cwd: "/w" } };
      update(sessionId, { sessionUpdate: "tool_call", ...call });
      const result = await ask({ sessionId, toolCall: call, options: OPTIONS });
      text(sessionId, `picked:${picked(result)}`);
      return end();
    }
    case "guarded": {
      const push = commandCall("cmd-1", "git push origin HEAD");
      update(sessionId, { sessionUpdate: "tool_call", ...push });
      const first = picked(await ask({ sessionId, toolCall: push, options: OPTIONS }));
      if (first === "deny") update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "cmd-1", status: "failed" });
      const list = commandCall("cmd-2", "ls build");
      update(sessionId, { sessionUpdate: "tool_call", ...list });
      const second = picked(await ask({ sessionId, toolCall: list, options: OPTIONS }));
      text(sessionId, `picked:${first} picked:${second}`);
      return end();
    }
    case "mcp-plan-tool":
    case "mcp-design-tool": {
      const tool = scenario === "mcp-plan-tool" ? "tasks_set" : "design_delete";
      const call = {
        toolCallId: "mcp-1",
        kind: "other",
        status: "pending",
        title: `milagre_${tool}`,
        rawInput: { arguments: { id: "x" } },
        _meta: { mcp: { tool, server: "milagre" }, is_mcp_tool_call: true },
      };
      update(sessionId, { sessionUpdate: "tool_call", ...call });
      const result = await ask({ sessionId, toolCall: call, options: OPTIONS });
      text(sessionId, `picked:${picked(result)}`);
      return end();
    }
    case "kiro-tools": {
      // A tool call reports its command first; the permission request that follows names only its title.
      const edit = { type: "diff", path: `${process.cwd()}/notes.txt`, oldText: null, newText: "hello\n" };
      const results = [];
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        title: "Edit notes.txt",
        kind: "edit",
        status: "pending",
        content: [edit],
        locations: [{ path: edit.path }],
      });
      results.push(picked(await ask({ sessionId, toolCall: { toolCallId: "edit-1", title: "Edit notes.txt" }, options: OPTIONS })));
      for (const [toolCallId, command] of [
        ["run-1", "git status --short"],
        ["run-2", "git push origin main"],
      ]) {
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Run Command",
          kind: "execute",
          status: "pending",
          rawInput: { command, cwd: process.cwd() },
        });
        results.push(picked(await ask({ sessionId, toolCall: { toolCallId, title: command }, options: OPTIONS })));
      }
      text(sessionId, `picked:${results.join(",")}`);
      return end();
    }
    case "edit": {
      const diff = { type: "diff", path: `${process.cwd()}/notes.txt`, oldText: "a\nb\n", newText: "a\nc\n", _meta: { kind: "modify" } };
      const call = { toolCallId: "ask-1", title: "Run create_file?", kind: "edit", status: "pending", content: [diff], locations: [{ path: diff.path }] };
      update(sessionId, { sessionUpdate: "tool_call", ...call });
      const result = await ask({ sessionId, toolCall: call, options: OPTIONS });
      if (picked(result).startsWith("allow")) {
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "run-1",
          title: "Running edit_file",
          kind: "edit",
          status: "in_progress",
          locations: [{ path: diff.path }],
          rawInput: { file_path: diff.path },
        });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "run-1", status: "completed", rawOutput: "Edit notes" });
      }
      text(sessionId, `picked:${picked(result)}`);
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "ask-1", status: "failed", rawOutput: "Tool call was approved but never executed." });
      return end();
    }
    case "question": {
      const result = await ask({
        sessionId,
        toolCall: { toolCallId: "interaction_7", title: "Which color?", kind: "other", status: "pending" },
        options: [
          { optionId: "red", name: "Red", kind: "allow_once" },
          { optionId: "green", name: "Green", kind: "allow_once" },
        ],
      });
      text(sessionId, `picked:${picked(result)}`);
      return end();
    }
    case "json":
      text(sessionId, "Here you go:\n```json\n");
      text(sessionId, JSON.stringify({ title: "Fix mobile login redirect", model, cwd: sessionCwd, mcpServers: sessionMcp }));
      text(sessionId, "\n```");
      return end();
    case "json-permission": {
      const call = { toolCallId: "cmd-1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { CommandLine: "rm -rf build", Cwd: "/w" } };
      const result = await ask({ sessionId, toolCall: call, options: OPTIONS });
      text(sessionId, JSON.stringify({ title: "Clean the build", picked: picked(result) }));
      return end();
    }
    case "plan":
      update(sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read", status: "completed", priority: "high" },
          { content: "Write", status: "in_progress", priority: "medium" },
          { content: "Test", status: "pending", priority: "low" },
        ],
      });
      text(sessionId, "Planned");
      return end();
    case "slow":
    case "stubborn":
    case "stubborn-command":
      // Antigravity's harness runs each command in a group of its own, outside the agent's.
      if (scenario === "stubborn-command")
        commandPid = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }).pid;
      text(sessionId, "Working");
      promptWaiter = { id, sessionId };
      return undefined;
    case "crash":
      process.stderr.write("I1007 21:18:18.878412 8444297088 server.py:2824] Starting the turn\n");
      process.stderr.write("E1007 21:18:19.000000 8444297088 server.py:99] boom: model unavailable\n");
      process.stderr.write("W1007 21:18:19.100000 8444297088 telemetry.py:431] dropping telemetry batch\n");
      setTimeout(() => process.exit(1), 20);
      return undefined;
    case "prompt-login":
      return send({ id, error: { code: -32000, message: "Authentication required" } });
    default:
      text(sessionId, "Hel");
      text(sessionId, "lo");
      // Kiro says what the turn cost just before it ends.
      if (kiro)
        update(sessionId, {
          sessionUpdate: "session_info_update",
          _meta: {
            kiro: {
              kind: "turn_completion",
              promptTurnSummaries: [
                { unit: "credit", unitPlural: "credits", usage: 0.03 },
                { unit: "credit", usage: 0.01 },
              ],
            },
          },
        });
      return end();
  }
}

if (scenario === "sign-in-line") {
  process.stdout.write("Open the following link to authenticate the ACP server: https://accounts.example/auth?x=1\n");
  process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.example/auth?x=2\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  received.push(message);
  const { id, method, params = {} } = message;
  if (method === undefined) {
    if (waiting && waiting.id === id) {
      const { resolve } = waiting;
      waiting = null;
      resolve(message.result ?? null);
    }
    return;
  }
  const mcpRefused =
    (scenario === "reject-mcp" && params.mcpServers?.length) ||
    (scenario === "reject-extra-mcp" && params.mcpServers?.some((server) => server.name !== "milagre"));
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: scenario === "no-resume" ? { list: {} } : { list: {}, resume: {} } },
          authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
          agentInfo: { name: "antigravity-acp", version: "1.3.0" },
        },
      });
    case "session/new":
      if (scenario === "logged-out") return send({ id, error: { code: -32000, message: "Authentication required" } });
      if (scenario === "subscription") return send({ id, error: { code: -32000, message: "SUBSCRIPTION_REQUIRED: not eligible" } });
      if (mcpRefused) return send({ id, error: { code: -32602, message: "bad mcp server" } });
      sessions += 1;
      sessionCwd = params.cwd;
      sessionMcp = params.mcpServers;
      return send({ id, result: sessionResult(`sess-${sessions}`) });
    case "session/resume":
      if (params.sessionId === "missing") return send({ id, error: { code: -32002, message: "Session not found" } });
      if (mcpRefused) return send({ id, error: { code: -32602, message: "bad mcp server" } });
      return send({ id, result: sessionResult() });
    case "session/load":
      if (params.sessionId === "missing") return send({ id, error: { code: -32002, message: "Session not found" } });
      update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      text(params.sessionId, "old answer");
      return send({ id, result: sessionResult() });
    case "session/set_config_option":
      if (params.configId === "model") {
        if (params.value === "nope") return send({ id, error: { code: -32602, message: "Unknown model" } });
        model = params.value;
        if (kiro) effortLevel = kiroDefaultEffort(model);
      }
      if (params.configId === "mode") mode = params.value;
      if (params.configId === "effortLevel") effortLevel = params.value;
      if (params.configId === "autopilot") autopilot = params.value;
      return send({ id, result: { configOptions: configOptions() } });
    case "session/prompt":
      return void runPrompt(id, params.sessionId);
    case "session/cancel":
      if (scenario === "slow" && promptWaiter) {
        send({ id: promptWaiter.id, result: { stopReason: "cancelled" } });
        promptWaiter = null;
      }
      return undefined;
    case "fake/finish":
      if (promptWaiter) send({ id: promptWaiter.id, result: { stopReason: "end_turn" } });
      promptWaiter = null;
      return send({ id, result: {} });
    case "fake/received":
      return send({ id, result: { received, sessions, model, mode, commandPid } });
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
      return undefined;
  }
});
