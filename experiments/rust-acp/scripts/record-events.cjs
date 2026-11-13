#!/usr/bin/env node
// Executes repository-owned Node mapper/helpers only. No vendor, profile, process or network.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const sources = {};
const read = (name) => {
  const source = fs.readFileSync(path.join(root, name), "utf8");
  sources[name] = crypto.createHash("sha256").update(source).digest("hex");
  return source;
};
const loaded = new Map();
const unused = () => {
  throw new Error("Unmapped dependency invoked by pure recorder");
};
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const module = { exports: {} };
  const requirePure = (id) => {
    if (id === "node:path") return path.posix;
    if (id === "@milagre/shared/tool-activity") return sharedMetadata;
    if (id === "@milagre/shared/agent-runs") return sharedRuns;
    // None is used by ACP's pure mapper. Fail if the execution boundary ever changes.
    if (id === "../chat-plan-tools.cjs") return { PLAN_TOOL_NAMES: [] };
    if (id === "../routines/tools.cjs") return { ROUTINE_TOOL_NAMES: [] };
    if (id === "../babysit-guard.cjs") return { babysitDenial: unused };
    if (id === "../bundled-skills.cjs") return { BUNDLED_SKILLS_DIRECTORY: "/fixture/unused" };
    if (["./permissions.cjs", "./steps.cjs", "./tasks.cjs"].includes(id)) return load(`packages/core/src/agents/${id.slice(2)}`);
    throw new Error(`Unexpected require ${id}`);
  };
  vm.runInNewContext(
    read(name),
    {
      module,
      exports: module.exports,
      require: requirePure,
      Map,
      Set,
      Date: {
        now() {
          throw new Error("Recorder requires explicit clock");
        },
      },
    },
    { filename: name },
  );
  loaded.set(name, module.exports);
  return module.exports;
}
// Import actual shared modules. Their dependencies are pure repository-owned presentation code.
for (const name of ["packages/shared/src/tool-activity.mjs", "packages/shared/src/agent-runs.mjs"]) read(name);
const sharedMetadata = require(path.join(root, "packages/shared/src/tool-activity.mjs"));
const sharedRuns = require(path.join(root, "packages/shared/src/agent-runs.mjs"));
const mapper = load("packages/core/src/agents/acp-events.cjs");
const cases = [];
const plain = (value) => JSON.parse(JSON.stringify(value, (_key, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v)));
function state(value = {}) {
  const s = plain(value);
  for (const key of ["calls", "editDiffs"]) if (s[key] != null) s[key] = new Map(s[key]);
  if (s.steps != null) s.steps = new Set(s.steps);
  return s;
}
function record(fn, args, s, now = 0, label = fn) {
  const before = s && plain(s);
  const clock = [];
  if (s)
    s.now = () => {
      clock.push(now);
      return now;
    };
  const result = mapper[fn](...args, ...(s ? [s] : []));
  if (s) delete s.now;
  cases.push({
    label,
    fn,
    args: plain(args),
    ...(s ? { before, now, clock, after: plain(s) } : {}),
    defined: result !== undefined,
    result: result === undefined ? null : plain(result),
  });
  return result;
}
function sequence(label, updates, initial = { turnId: "turn-1", hasText: false, textBreak: false, calls: [], steps: [], editDiffs: [] }) {
  const s = state(initial);
  let now = 1000;
  for (const update of updates) record("mapAcpUpdate", [update], s, (now += 1250), label);
  record("closeThinking", [], s, now + 64_499, `${label}/close`);
}
const chunk = (sessionUpdate, text) => ({ sessionUpdate, content: { type: "text", text } });
const thought = (text) => chunk("agent_thought_chunk", text);
const text = (value) => chunk("agent_message_chunk", value);
// Previously recorded raw updates came from the real Node fake-provider session fixture.
const rawTraces = JSON.parse(read("experiments/rust-acp/tests/fixtures/node-traces.json"));
for (const scenario of rawTraces.scenarios) {
  sequence(
    `node-fake/${scenario.scenario}`,
    scenario.events.filter((e) => e.method === "session/update").map((e) => e.params.update),
  );
  record("stopReasonEvent", [scenario.result.stopReason, "Fake"]);
}
sequence("paragraphs-thinking", [
  text("First"),
  thought("one"),
  thought(" two"),
  chunk("agent_message_chunk", ""),
  { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "ignored" } },
  text("Second"),
  thought("three"),
  { sessionUpdate: "tool_call", toolCallId: "shell", kind: "execute", rawInput: { command: "pwd" } },
  text("Third"),
  { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed" },
  text("Fourth"),
]);
const diff = { type: "diff", path: "/repo/new.rs", oldText: null, newText: "one\ntwo\n" };
sequence("approval-borrows-diff", [
  thought("thinking"),
  { sessionUpdate: "tool_call", toolCallId: "approval", kind: "edit", status: "pending", content: [diff] },
  { sessionUpdate: "tool_call", toolCallId: "execution", kind: "edit", status: "in_progress", locations: [{ path: diff.path }] },
  { sessionUpdate: "tool_call_update", toolCallId: "execution", status: "completed" },
  { sessionUpdate: "tool_call_update", toolCallId: "approval", status: "failed", rawOutput: "Approved but never executed" },
]);
sequence("suppressed-failure-clears-thinking", [
  thought("discarded completion"),
  { sessionUpdate: "tool_call", toolCallId: "approval", status: "failed", rawOutput: "APPROVED BUT NEVER EXECUTED" },
  text("after"),
]);
sequence("interleaved-merge", [
  { sessionUpdate: "tool_call", toolCallId: "b", kind: "execute", rawInput: { command: "ls", cwd: "/repo", nested: { old: true } }, _meta: { vendor: 1 } },
  { sessionUpdate: "tool_call", toolCallId: "a", kind: "search", rawInput: { query: "foo" } },
  { sessionUpdate: "tool_call_update", toolCallId: "b", rawInput: { command: "pwd", nested: { new: true } }, rawOutput: { stdout: "ok" } },
  { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" },
  { sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", rawInput: null },
  { sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", kind: "read", title: "fresh" },
]);
sequence("approval-cache-order", [
  {
    sessionUpdate: "tool_call",
    toolCallId: "p",
    status: "pending",
    content: [diff, { ...diff, path: "/repo/b", newText: "b" }, { ...diff, newText: "again" }],
  },
  { sessionUpdate: "tool_call_update", toolCallId: "p", status: "pending", content: [{ ...diff, newText: "replace" }] },
  { sessionUpdate: "tool_call", toolCallId: "run", status: "completed", kind: "edit", locations: [{ path: "/repo/b" }] },
]);
for (const kind of ["execute", "read", "edit", "delete", "move", "search", "fetch", "other", "future", null]) {
  for (const status of ["pending", "in_progress", "completed", "failed", null, "future"]) {
    sequence(`kind/${kind}/${status}`, [
      {
        sessionUpdate: "tool_call",
        toolCallId: "id",
        kind,
        status,
        title: "Running tool_name",
        rawInput: { command: "echo `a`\n b", query: "q", url: "https://example.invalid", path: "/repo/a.rs" },
        rawOutput: { stdout: "done\r\n", exitCode: status === "completed" ? 3 : 0 },
      },
    ]);
  }
}
for (const id of [null, "", 0, false, "interaction_x", "interaction_", "x", 123, 1e21, 1e-7, [1, 2], { id: 1 }]) {
  record("isQuestionCall", [id]);
  sequence(`id/${JSON.stringify(id)}`, [{ sessionUpdate: "tool_call", toolCallId: id, kind: "read", status: "completed" }], {});
}
const calls = [
  {},
  { toolCallId: null },
  ...["CommandLine", "command_line", "commandLine", "command", "cmd"].map((key) => ({
    kind: "execute",
    rawInput: { [key]: "echo hi" },
    rawOutput: { [key]: "fallback" },
  })),
  ...["Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"].map((key) => ({ rawOutput: { [key]: "/cwd" } })),
  ...["AbsolutePath", "TargetFile", "file_path", "filePath", "path", "File", "file"].map((key) => ({ kind: "read", rawInput: { [key]: "/a/b.txt/" } })),
  { kind: "read", locations: [null, {}, { path: "" }, { path: "/ignored" }], content: [diff] },
  { kind: "edit", content: [null, 1, { type: "diff", path: 3 }, diff] },
  ...[
    "Running view_file",
    "Run tool.name:one-two?",
    "Run bad name?",
    "  ",
    "work now",
    "x\u0085y",
    "\ufeffRun\tfoo?\ufeff",
    "Running x\ny",
    "x".repeat(100),
  ].map((title) => ({ title })),
  ...[
    null,
    "",
    false,
    3,
    [1, null, "x"],
    { z: 0, 10: 10, 2: 2, "01": 1 },
    { exitCode: 1, stdout: "err" },
    { exitCode: null, exit_code: 2 },
    { exitCode: "1", combinedOutput: "str" },
  ].map((rawOutput) => ({ rawOutput })),
  {
    content: [
      { type: "content", content: { type: "text", text: "hello\r\n" } },
      { type: "content", content: { type: "text", text: "world" } },
    ],
    rawOutput: "ignored",
  },
  { content: [{ type: "content", content: { type: "text", text: 5 } }] },
];
for (const [index, c] of calls.entries()) {
  const call = { toolCallId: `helper-${index}`, ...c };
  for (const fn of ["commandOf", "cwdOf", "fileOf", "diffsOf", "acpStep", "acpStepResult"]) record(fn, [call]);
}
for (const oldText of [null, "", "a", "a\n", "a\nb\nc\n", "\r\n\r\n", false])
  for (const newText of ["", "a", "a\n", "a\nB\nc\n", "a\nb\nc\nd\n", "a\r\nb\r\n"]) {
    const d = { path: "/a", oldText, newText };
    record("acpDiff", [d]);
    record("createsFile", [d]);
  }
for (const d of [null, {}, { oldText: "", _meta: { kind: "add" } }, { oldText: "a", _meta: { kind: "delete" } }]) record("createsFile", [d]);
for (const diffs of [[], [diff], [diff, { ...diff, path: "/b", newText: "b" }], [{ ...diff, newText: "x".repeat(21_000) }]]) record("acpDiffText", [diffs]);
const metadata = { server: "milagre", tool: "heartbeat_create" };
for (const mcp of [metadata, { server: "other", tool: "heartbeat_create" }, {}, [], null, false])
  for (const rawOutput of ['{"routine":{"id":"r","name":"Name","extra":1}}\n  scheduled \n', '{"routine":{"id":"","name":"Name"}}', "not JSON"])
    record("acpStepResult", [{ toolCallId: "hb", title: "milagre_heartbeat_create", _meta: { mcp }, rawOutput }]);
for (const tool of ["shell", "design_show", "design_apply", "artifact_show", "html_render", "html_preview"])
  for (const input of [null, {}, false, { token: "secret", nested: { API_KEY: "hidden", password: 123 }, valid: "okay" }, { body: "x".repeat(5000) }])
    record("acpStep", [
      {
        toolCallId: "mcp",
        kind: "other",
        title: "Running my_tool",
        _meta: { is_mcp_tool_call: true, mcp: { server: "s".repeat(170), tool } },
        rawInput: input,
      },
    ]);
for (const kind of ["read", "execute", "edit", "other"])
  for (const status of ["completed", "failed"])
    record("acpStepResult", [
      { toolCallId: "long", kind, status, rawOutput: "begin:" + "x".repeat(20_000) + ":end", content: [{ ...diff, newText: "y".repeat(21_000) }] },
    ]);
for (const duration of [-100, 0, 499, 1499, 1500, 59_499, 59_500, 60_500, 125_000])
  record("closeThinking", [], state({ thinking: { id: "t", text: "thought", startedAt: 1000 } }), 1000 + duration);
for (const entries of [
  null,
  {},
  [],
  [
    null,
    {},
    { content: "  " },
    { content: "\ufeff one \ufeff", status: "unknown" },
    { content: "two", status: "in_progress" },
    { content: "three", status: "completed" },
  ],
])
  sequence("plan", [{ sessionUpdate: "plan", entries }]);
for (const used of [0, 10, -1, "10", null])
  for (const size of [0, 100, -1, "100", true, null, [20], {}, "0x20", "0b10", "0o10", "inf"])
    sequence("usage", [{ sessionUpdate: "usage_update", used, size }]);
sequence("configs-credits", [
  {
    sessionUpdate: "config_option_update",
    configOptions: [
      { id: "model", currentValue: "a", options: [null, { value: 1 }, { value: "a", name: "A", custom: 1 }] },
      { id: "effortLevel", currentValue: "high" },
      { id: "autopilot", currentValue: "on" },
    ],
  },
  {
    sessionUpdate: "config_option_update",
    configOptions: [
      { category: "model", currentValue: "b" },
      { category: "mode", currentValue: "plan" },
    ],
  },
  { sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "c", options: [] }] },
  { sessionUpdate: "current_mode_update", currentModeId: "default" },
  { sessionUpdate: "current_mode_update", currentModeId: 3 },
  {
    sessionUpdate: "session_info_update",
    _meta: {
      kiro: {
        kind: "turn_completion",
        promptTurnSummaries: [
          null,
          { unit: "credit", usage: 0.1 },
          { unit: "credit", usage: 0.2 },
          { unit: "token", usage: 2 },
          { unit: "credit", usage: "3" },
        ],
      },
    },
  },
  { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "turn_completion", promptTurnSummaries: [] } } },
  { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "other", promptTurnSummaries: [{ unit: "credit", usage: 9 }] } } },
  null,
  {},
  { sessionUpdate: "future" },
]);
for (const options of [
  null,
  [],
  [null],
  [{ id: "model" }, { id: "effortLevel", currentValue: null }],
  [
    { id: "model", options: [] },
    { id: "model", currentValue: "last" },
  ],
  [{ id: "mode", currentValue: "" }],
])
  record("readConfigOptions", [options], state({ effortLevel: "old", models: ["old"] }));
for (const reason of [null, "end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal", "future", 4])
  for (const name of ["Kiro", "Antigravity"]) record("stopReasonEvent", [reason, name]);
// Supplemental Unicode and numeric presentation boundaries that remain representable in Rust.
for (const title of ["café", "👩‍💻 read", "x".repeat(78) + "🌍tail", "\u0085not-whitespace\u0085", "\u2003Run foo?\u2003"]) {
  // Keep surrogate-splitting cases in the explicit deviation recorder below.
  if (title.includes("tail")) continue;
  record("acpStep", [{ toolCallId: "unicode", title }]);
}
for (const n of [1e-100, 1e-7, 1e-6, 1e20, 1e21, 1e100, Number("9007199254740993"), 1000000000000000100, -0, -1e21, Number.MIN_VALUE, Number.MAX_VALUE]) {
  record("acpStepResult", [{ toolCallId: n, rawOutput: { number: n } }]);
}
let seed = 0x75abc321;
for (let i = 0; i < 100; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const n = (seed / 0xffffffff) * 10 ** ((i % 40) - 20);
  record("acpStepResult", [{ toolCallId: n, rawOutput: n }]);
}
// JSON cannot transport lone surrogates into serde_json::Value. Preserve the exact Node
// output as UTF-16 units, and separately assert Rust's documented valid-scalar truncation.
const deviations = [];
for (const [fn, call, field] of [
  ["acpStep", { toolCallId: "u", title: "x".repeat(78) + "🌍tail" }, "title"],
  ["acpStepResult", { toolCallId: "u", rawOutput: "x".repeat(19999) + "🌍tail" }, "detail"],
  ["acpStepResult", { toolCallId: "u", kind: "execute", rawOutput: "🌍" + "x".repeat(19999) }, "detail"],
]) {
  const value = mapper[fn](call)[field];
  const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
  const scalarText = Array.from(value)
    .filter((c) => c.length === 2 || c.charCodeAt(0) < 0xd800 || c.charCodeAt(0) > 0xdfff)
    .join("");
  deviations.push({ fn, call, field, nodeUtf16: units, rustScalarText: scalarText });
}
const output = JSON.stringify({ sources, cases, deviations }, null, 2) + "\n";
const target = path.join(__dirname, "../tests/fixtures/node-event-traces.json");
if (process.argv.includes("--check")) {
  if (JSON.stringify(JSON.parse(fs.readFileSync(target, "utf8"))) !== JSON.stringify(JSON.parse(output)))
    throw new Error("Node mapper fixtures drifted; regenerate and review");
} else fs.writeFileSync(target, output);
console.log(`${cases.length} deterministic Node mapper/helper traces${process.argv.includes("--check") ? " verified" : " recorded"}`);
