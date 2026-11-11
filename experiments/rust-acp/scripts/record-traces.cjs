#!/usr/bin/env node
// Repository-owned Node ACP implementations and fake agents only. No vendor executable or SDK.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "../../..");
const { AcpRpc } = require(path.join(root, "packages/core/src/agents/acp-rpc.cjs"));
const acpSource = fs.readFileSync(path.join(root, "packages/core/src/agents/acp-session.cjs"), "utf8");
const context = { module: { exports: {} } };
vm.runInNewContext(
  acpSource.slice(acpSource.indexOf("function pickOption("), acpSource.indexOf("// Antigravity doesn't take")) +
    acpSource.slice(acpSource.indexOf("const outcome ="), acpSource.indexOf("class AcpSession")) +
    "\nmodule.exports={pickOption,outcome};",
  context,
);
const { pickOption, outcome } = context.module.exports;
const options = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "always", kind: "allow_always" },
  { optionId: "deny", kind: "reject_once" },
  { optionId: "never", kind: "reject_always" },
];
const permissions = [];
for (let mask = 0; mask < 16; mask++)
  for (const decision of ["allow", "allow-for-chat", "deny", "cancelled"])
    for (const once of [false, true]) {
      const offered = options.filter((_, i) => mask & (1 << i));
      permissions.push({ options: offered, decision, once, expected: outcome(pickOption(offered, decision, { once })) });
    }
const frames = [];
const recorder = new AcpRpc();
recorder.child = { stdin: { write: (line) => frames.push(JSON.parse(line)) } };
const requests = [
  [
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "milagre", title: "Milagre", version: "test" },
    },
  ],
  ["authenticate", { methodId: "oauth-personal" }],
  ["session/new", { cwd: "/workspace", mcpServers: [{ type: "http", name: "milagre", url: "http://127.0.0.1:1/mcp", headers: [] }] }],
  ["session/resume", { sessionId: "saved", cwd: "/workspace", mcpServers: [] }],
  ["session/load", { sessionId: "saved", cwd: "/workspace", mcpServers: [] }],
  [
    "session/prompt",
    {
      sessionId: "saved",
      prompt: [
        { type: "text", text: "hi" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    },
  ],
];
async function main() {
  for (const [method, params] of requests) {
    const pending = recorder.request(method, params, { timeoutMs: 0 });
    recorder.handleLine(JSON.stringify({ id: frames.at(-1).id, result: { ok: true } }));
    await pending;
  }
  recorder.notify("session/cancel", { sessionId: "saved" });
  recorder.notify("no-params");
  recorder.respond("permission-id", outcome(options[2]));
  recorder.respond(0, null);
  recorder.respondError(7, "unsupported");
  const envelopes = [];
  for (const message of [
    null,
    17,
    "text",
    [],
    {},
    { method: "", id: 0, params: null },
    { method: "session/update", id: null, params: { sessionId: "s", update: { sessionUpdate: "future_type", opaque: [1] } } },
    { method: "session/request_permission", id: "7", params: { toolCall: { kind: "execute" }, options } },
    { id: 1, result: null },
    { id: 1, result: false },
    { id: 1, error: { code: -32000, message: "Authentication required", data: { vendor: "opaque" } } },
    { id: "1", result: { wrong: true } },
  ]) {
    const rpc = new AcpRpc();
    const events = [];
    rpc.on("line", (v) => events.push({ type: "line", ...v }));
    rpc.on("request", (v) => events.push({ type: "request", ...v }));
    rpc.on("notification", (v) => events.push({ type: "notification", ...v }));
    rpc.pending.set(1, {
      method: "test",
      resolve: (result) => events.push({ type: "response", result }),
      reject: (error) => events.push({ type: "error", error: error.rpcError }),
    });
    rpc.handleLine(JSON.stringify(message));
    envelopes.push({ message, events });
  }
  const scenarios = [];
  for (const scenario of ["reply", "thinking", "command", "failing-command", "permission", "edit", "question", "plan", "kiro-tools", "no-resume"]) {
    const rpc = new AcpRpc({
      command: process.execPath,
      args: [path.join(root, "packages/core/src/agents/fixtures/fake-acp-agent.cjs")],
      env: { FAKE_SCENARIO: scenario },
      cwd: root,
      name: "Fake",
    });
    const events = [];
    rpc.on("notification", (n) => events.push({ type: "notification", ...n }));
    rpc.on("request", (r) => {
      events.push({ type: "request", ...r });
      rpc.respond(r.id, outcome(pickOption(r.params.options ?? [], "deny")));
    });
    rpc.start();
    try {
      const init = await rpc.request("initialize", requests[0][1]);
      const session = await rpc.request("session/new", { cwd: "/workspace", mcpServers: [] });
      if (scenario === "no-resume") await rpc.request("session/load", { sessionId: session.sessionId, cwd: "/workspace", mcpServers: [] });
      const result = await rpc.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] });
      scenarios.push({ scenario, init, session, result, events });
    } finally {
      await rpc.close();
    }
  }
  const install = fs.readFileSync(path.join(root, "packages/core/src/agents/antigravity-install.cjs"), "utf8");
  const vendor = fs.readFileSync(path.join(root, "packages/core/src/agents/antigravity-acp.cjs"), "utf8");
  const launchContext = {
    module: { exports: {} },
    path,
    process,
    SCRUBBED_ENV: vm.runInNewContext(install.slice(install.indexOf("const AMBIENT_ENV ="), install.indexOf("const unlink =")) + "AMBIENT_ENV"),
    memberNames: (p) => ({ harness: p === "win32" ? "localharness_external.exe" : "localharness_external" }),
  };
  vm.runInNewContext(
    vendor.slice(vendor.indexOf("function antigravityEnv("), vendor.indexOf("function antigravitySpawn(")) + "\nmodule.exports={antigravityEnv};",
    launchContext,
  );
  const env = {
    KEEP: "kept",
    GEMINI_HOME: "/private/profile",
    ...Object.fromEntries(launchContext.SCRUBBED_ENV.filter((k) => k !== "GEMINI_HOME").map((k) => [k, "ambient"])),
  };
  const launches = ["darwin", "linux", "win32"].map((platform) => ({
    platform,
    env,
    harness: "/private/harness",
    tmpdir: "/private/tmp",
    expected: launchContext.module.exports.antigravityEnv({ env, harness: "/private/harness", tmpdir: "/private/tmp", platform }),
  }));
  const sources = ["acp-rpc.cjs", "acp-session.cjs", "kiro-acp.cjs", "antigravity-acp.cjs", "antigravity-install.cjs", "fixtures/fake-acp-agent.cjs"].map(
    (name) => ({
      name,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, "packages/core/src/agents", name)))
        .digest("hex"),
    }),
  );
  const normalize = (value) =>
    typeof value === "string"
      ? value.startsWith(root)
        ? "/fixture" + value.slice(root.length)
        : value
      : Array.isArray(value)
        ? value.map(normalize)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
          : value;
  const result = JSON.stringify(normalize({ sources, frames, envelopes, permissions, scenarios, launches }), null, 2) + "\n";
  const output = path.join(__dirname, "../tests/fixtures/node-traces.json");
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(output, "utf8"))) !== JSON.stringify(JSON.parse(result))) throw new Error("ACP Node fixture drift");
  } else fs.writeFileSync(output, result);
  console.log(
    `${frames.length} wire frames, ${envelopes.length} envelopes, ${permissions.length} permission cases, ${scenarios.length} fake sessions, ${launches.length} launch cases`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
