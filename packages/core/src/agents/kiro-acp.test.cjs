const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AcpRpc } = require("./acp-rpc.cjs");
const { AcpSession } = require("./acp-session.cjs");
const { KIRO_ACP_ARGS, crashDetail, isLoginError, kiroAcp, kiroAgentFor, resolveEffort } = require("./kiro-acp.cjs");
const { isTerminal } = require("./events.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.cjs");

function kiro(t, scenario = "kiro") {
  const events = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-kiro-cwd-"));
  const spawned = [];
  const session = new AcpSession({
    cwd,
    command: "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat",
    clientVersion: "test",
    config: kiroAcp,
    emit: (event) => events.push(event),
    createRpc: (options) => {
      spawned.push(options);
      return new AcpRpc({ ...options, command: process.execPath, args: [FAKE], env: { ...options.env, FAKE_SCENARIO: scenario } });
    },
  });
  t.after(async () => {
    await session.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { session, events, spawned, cwd };
}
const ended = (events, count = 1) => waitUntil(() => events.filter(isTerminal).length >= count);
const configSent = async (session) =>
  (await session.rpc.request("fake/received")).received
    .filter((message) => message.method === "session/set_config_option")
    .map((message) => [message.params.configId, message.params.value]);

test("Kiro runs the agent binary on the v3 engine", async (t) => {
  const { session, events, spawned } = kiro(t);
  await session.startTurn({ prompt: "Hi", images: [], model: "kiro:auto", permissionMode: "auto" });
  await ended(events);
  assert.equal(spawned[0].command, "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat");
  assert.deepEqual(spawned[0].args, KIRO_ACP_ARGS);
  assert.deepEqual(KIRO_ACP_ARGS, ["acp", "--agent-engine", "v3"]);
});

test("Kiro gets its own model id and the effort its model takes; autopilot stays on and its agent mode is never set", async (t) => {
  const { session, events } = kiro(t);
  await session.startTurn({ prompt: "Hi", images: [], model: "kiro:claude-opus-5.5", effort: "high", permissionMode: "ask" });
  await ended(events);
  // Nothing changed: nothing is sent.
  await session.startTurn({ prompt: "Again", images: [], model: "kiro:claude-opus-5.5", effort: "high", permissionMode: "ask" });
  await ended(events, 2);
  // Auto takes no effort.
  await session.startTurn({ prompt: "Cheaper", images: [], model: "kiro:auto", effort: "high", permissionMode: "auto" });
  await ended(events, 3);
  assert.deepEqual(await configSent(session), [
    ["model", "claude-opus-5.5"],
    ["effortLevel", "high"],
    ["autopilot", "on"],
    ["model", "auto"],
  ]);
  // The session keeps Kiro's options as they came, credits included, for the picker.
  const { _meta: meta } = session.models.find((model) => model.value === "claude-opus-5.5");
  assert.equal(meta.kiro.rateMultiplier, 2);
});

test("an effort the model doesn't list is left to Kiro", () => {
  const offered = [
    { value: "claude-opus-5.5", _meta: { kiro: { effortLevels: ["low", "medium", "high"] } } },
    { value: "auto", _meta: { kiro: {} } },
  ];
  assert.equal(resolveEffort({ model: "claude-opus-5.5", effort: "high", offered }), "high");
  assert.equal(resolveEffort({ model: "claude-opus-5.5", effort: "ultra", offered }), null);
  assert.equal(resolveEffort({ model: "auto", effort: "high", offered }), null);
  assert.equal(resolveEffort({ model: "claude-opus-5.5", effort: undefined, offered }), null);
});

test("the agent binary is the one beside kiro-cli's real path, else Kiro's app", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-kiro-bin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Kiro CLI.app", "Contents", "MacOS");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of ["kiro-cli", "kiro-cli-chat"]) fs.writeFileSync(path.join(app, name), "#!/bin/sh\n", { mode: 0o755 });
  // Homebrew links the launcher into bin; the agent only sits beside its real path.
  fs.symlinkSync(path.join(app, "kiro-cli"), path.join(root, "bin", "kiro-cli"));
  assert.equal(kiroAgentFor(path.join(root, "bin", "kiro-cli")), fs.realpathSync(path.join(app, "kiro-cli-chat")));
  // No launcher on PATH: the app's own copy, where one is installed.
  const exists = (file) => file === "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat";
  assert.equal(kiroAgentFor(null, { exists }), process.platform === "darwin" ? "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat" : null);
  assert.equal(kiroAgentFor(null, { exists: () => false }), null);
});

test("a sign-in error is told apart from other errors", () => {
  const rpc = (code, message) => Object.assign(new Error(message), { rpcError: { code, message } });
  assert.equal(isLoginError(rpc(-32000, "Authentication required")), true);
  assert.equal(isLoginError(rpc(-32603, "Not logged in. Run kiro-cli login")), true);
  assert.equal(isLoginError(rpc(-32603, "Model not available")), false);
  assert.equal(isLoginError(new Error("Not logged in")), false);
});

test("a crash names the agent's last error line without its log prefix", () => {
  assert.equal(crashDetail("starting\n2026-10-30T14:49:46.060Z ERROR kiro::acp: token refresh failed\nbye"), "token refresh failed");
  assert.equal(crashDetail("error: failed to launch /Users/me/.local/bin/kiro-cli-chat"), "failed to launch /Users/me/.local/bin/kiro-cli-chat");
  assert.equal(crashDetail(""), "");
});

test("in Auto, edits inside the worktree and safe commands run; a risky command gets a card that says why", async (t) => {
  const { session, events } = kiro(t, "kiro-tools");
  await session.startTurn({ prompt: "Go", images: [], model: "kiro:auto", permissionMode: "auto" });
  await waitUntil(() => events.some((event) => event.type === "permission-request"));
  const cards = events.filter((event) => event.type === "permission-request");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].command, "git push origin main");
  assert.equal(cards[0].reason, "Writes to GitHub.");
  session.respondToPermission(cards[0].requestId, "deny");
  await ended(events);
  assert.match(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
    /picked:allow,allow,deny/,
  );
});

test("in Ask, every request Kiro makes gets a card", async (t) => {
  const { session, events } = kiro(t, "kiro-tools");
  await session.startTurn({ prompt: "Go", images: [], model: "kiro:auto", permissionMode: "ask" });
  for (let count = 1; count <= 3; count += 1) {
    await waitUntil(() => events.filter((event) => event.type === "permission-request").length === count);
    const card = events.findLast((event) => event.type === "permission-request");
    assert.equal(card.reason, undefined);
    session.respondToPermission(card.requestId, "allow");
  }
  await ended(events);
});

test("a Kiro turn ends with what it cost, in credits", async (t) => {
  const { session, events } = kiro(t);
  await session.startTurn({ prompt: "Hi", images: [], model: "kiro:auto", permissionMode: "auto" });
  await ended(events);
  const end = events.find((event) => event.type === "turn-completed");
  assert.equal(Math.round(end.credits * 100) / 100, 0.04);
});
