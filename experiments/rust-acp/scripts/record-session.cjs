#!/usr/bin/env node
// Actual Node AcpSession with fake RPC processes and explicit inert host dependencies.
// Records lifecycle events, raw permission requests and wire replies. Never loads vendor launch
// code, host instructions, accounts/profiles, MCP discovery or a real provider.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const agents = "packages/core/src/agents/";
const sources = {};
function source(name) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  sources[name] = crypto.createHash("sha256").update(text).digest("hex");
  return text;
}
let nextTurn = 0;
const impossible = () => {
  throw new Error("Host dependency escaped fake lifecycle recorder");
};
const sharedRuns = require(path.join(root, "packages/shared/src/agent-runs.mjs"));
const sharedTools = require(path.join(root, "packages/shared/src/tool-activity.mjs"));
for (const name of ["packages/shared/src/agent-runs.mjs", "packages/shared/src/tool-activity.mjs"]) source(name);
const { AcpRpc } = require(path.join(root, agents, "acp-rpc.cjs"));
source(agents + "acp-rpc.cjs");
source(agents + "fixtures/fake-acp-agent.cjs");
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const required = (id) => {
    if (id === "node:path") return path;
    if (id === "node:crypto") return { randomUUID: () => `turn-${++nextTurn}` };
    if (id === "node:fs/promises") return { rm: impossible };
    if (id === "node:fs") return fs;
    if (id === "@milagre/shared/agent-runs") return sharedRuns;
    if (id === "@milagre/shared/tool-activity") return sharedTools;
    if (id === "@milagre/shared/providers") return { cliName: () => "Fake ACP" };
    if (id === "@milagre/shared/prompt-parts") return { promptImageBlocks: (prompt) => [{ type: "text", text: prompt }] };
    if (id === "../chat-plan-tools.cjs") return { PLAN_TOOL_NAMES: [] };
    if (id === "../routines/tools.cjs") return { ROUTINE_TOOL_NAMES: [] };
    // Host policy is intentionally outside this fixture. Every request is manually answered.
    if (id === "../babysit-guard.cjs") return { babysitDenial: () => null };
    if (id === "../bundled-skills.cjs") return { BUNDLED_SKILLS_DIRECTORY: "/fixture/unused" };
    if (id === "../mcp/extras.cjs") return { readMcpExtras: impossible };
    if (id === "../mcp/definitions.cjs") return { toAcpServer: impossible };
    if (id === "../escalation-guard.cjs")
      return {
        acpCall: impossible,
        turnGuards: (guard) => {
          if (guard) impossible();
          return {};
        },
      };
    if (id === "./command-risk.cjs") return { commandRisk: impossible };
    if (id === "./antigravity-acp.cjs") return { antigravityAcp: {}, makeTempDir: impossible };
    if (id === "./acp-rpc.cjs") return { AcpRpc };
    if (id === "./events.cjs")
      return {
        sessionInstructions: () => "",
        RESUME_FAILED_MESSAGE: "fixture resume failed",
        failedWith: (message) => ({ type: "turn-failed", message }),
        crashMessage: () => "Fake ACP closed",
        loginMessage: impossible,
        missingCliMessage: impossible,
      };
    if (["./acp-events.cjs", "./permissions.cjs", "./steps.cjs", "./tasks.cjs", "./questions.cjs"].includes(id)) return load(agents + id.slice(2));
    throw new Error(`Unexpected dependency ${id}`);
  };
  vm.runInNewContext(
    source(name),
    { module, exports: module.exports, require: required, Map, Set, Date, setTimeout, clearTimeout, process: { env: {} } },
    { filename: name },
  );
  cache.set(name, module.exports);
  return module.exports;
}
const { AcpSession } = load(agents + "acp-session.cjs");
const terminal = (e) => ["turn-completed", "turn-cancelled", "turn-failed"].includes(e.type);
const plain = (v) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : typeof x === "function" ? undefined : x)));
const normalize = (v) =>
  typeof v === "string"
    ? v.replaceAll(root, "/checkout")
    : Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]))
        : v;
const wait = async (fn) => {
  const until = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > until) throw new Error("Node lifecycle fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
async function main() {
  const cases = [];
  for (const scenario of [
    "reply",
    "thinking",
    "command",
    "failing-command",
    "permission",
    "edit",
    "question",
    "plan",
    "kiro",
    "kiro-tools",
    "no-resume",
    "slow",
  ]) {
    nextTurn = 0;
    const events = [],
      permissionRequests = [],
      permissionCards = [],
      replies = [],
      frames = [];
    let session;
    session = new AcpSession({
      cwd: "/fixture",
      resumeId: scenario === "no-resume" ? "saved" : undefined,
      command: "fake-only",
      clientVersion: "fake-session",
      access: { roots: [], answer: () => null },
      tldrEnabled: false,
      config: {
        provider: "fake",
        name: "Fake ACP",
        modes: { ask: scenario.startsWith("kiro") ? "vibe" : "default" },
        spawn: () => ({}),
        isLoginError: () => false,
        crashDetail: () => "",
      },
      createRpc: () => {
        const rpc = new AcpRpc({
          command: process.execPath,
          args: [path.join(root, agents, "fixtures/fake-acp-agent.cjs")],
          cwd: root,
          env: { FAKE_SCENARIO: scenario },
          name: "Fake ACP",
        });
        const request = rpc.request.bind(rpc);
        rpc.request = (method, params, options) => {
          frames.push({ method, params });
          return request(method, params, options);
        };
        const respond = rpc.respond.bind(rpc);
        rpc.respond = (id, result) => {
          replies.push({ id, result });
          return respond(id, result);
        };
        rpc.on("request", (r) => permissionRequests.push(plain(r)));
        return rpc;
      },
      emit: (event) => {
        if (event.type === "permission-request") {
          permissionCards.push(plain(event));
          queueMicrotask(() => session.respondToPermission(event.requestId, scenario === "edit" ? "allow" : "deny"));
        } else if (event.type === "question-request") {
          permissionCards.push(plain(event));
          queueMicrotask(() => session.answerQuestion(event.requestId, { 0: ["Red"] }));
        } else if (!["permission-resolved", "question-resolved"].includes(event.type)) events.push(plain(event));
      },
    });
    session.state.now = () => 1000;
    try {
      await session.startTurn({ prompt: "hello", permissionMode: "ask" });
      if (scenario === "slow") {
        await wait(() => events.some((e) => e.text === "Working"));
        await session.interrupt();
      }
      await wait(() => events.some(terminal));
      if (scenario === "reply") {
        await session.startTurn({ prompt: "again", permissionMode: "ask" });
        await wait(() => events.filter(terminal).length === 2);
      }
      const snapshot = plain(session.state);
      delete snapshot.sessionId;
      delete snapshot.now;
      // A missing closed thinking record and an explicit null mean the same idle state.
      snapshot.thinking ??= null;
      cases.push({
        scenario,
        events,
        permissionRequests,
        permissionCards,
        replies,
        state: snapshot,
        frames: frames.filter((f) => ["initialize", "session/new", "session/load", "session/resume"].includes(f.method)),
      });
    } finally {
      await session.close();
    }
  }
  const result = JSON.stringify(normalize({ sources, cases }), null, 2) + "\n";
  const file = path.join(__dirname, "../tests/fixtures/node-session-traces.json");
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(JSON.parse(result))) throw new Error("Node session fixture drift");
  } else fs.writeFileSync(file, result);
  console.log(`${cases.length} actual Node fake-session lifecycle traces ${process.argv.includes("--check") ? "verified" : "recorded"}`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
